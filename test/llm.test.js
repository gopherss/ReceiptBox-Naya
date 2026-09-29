import { test } from 'node:test';
import assert from 'node:assert';
import config from '../src/config.js';

const realKey = config.llmApiKey;
const realFetch = globalThis.fetch;

/* Sustituye la llamada de red. extractReceipt va a leer config.llmApiKey y a
   hacer fetch a config.llmUrl, asi que basta con configurar ambos en el test. */
function fakeProvider(reply, { status = 200, statusText = 'OK' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: status < 400,
      status,
      statusText,
      json: async () => ({ content: [{ type: 'text', text: reply }] }),
    };
  };
  return calls;
}

function restoreProvider() {
  globalThis.fetch = realFetch;
  config.llmApiKey = realKey;
}

const VALID = {
  merchant: 'Lumen Coffee Co.',
  date: '2026-03-09',
  total: 18.4,
  currency: 'USD',
  category: 'meals',
  confidence: 0.87,
};

test.beforeEach(() => {
  config.llmApiKey = 'test-key';
});
test.afterEach(restoreProvider);

test('extracts a normal receipt', async () => {
  const calls = fakeProvider(JSON.stringify(VALID));
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  const out = await extractReceipt('any text');
  assert.equal(out.merchant, 'Lumen Coffee Co.');
  assert.equal(out.total, 18.4);
  assert.equal(out.category, 'meals');
  assert.equal(out.extractionError, null);
  assert.equal(calls.length, 1);
});

test('strips a markdown fence around the JSON', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider('```json\n' + JSON.stringify(VALID) + '\n```');
  const out = await extractReceipt('x');
  assert.equal(out.total, 18.4);
});

test('recovers the JSON when the reply has prose around it', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider('Here it is:\n' + JSON.stringify(VALID));
  const out = await extractReceipt('x');
  assert.equal(out.merchant, VALID.merchant);
});

test('handles a reply truncated in the middle as a review line', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider('{"merchant": "Lumen", ');
  const out = await extractReceipt('x');
  /* JSON incompleto: no se puede recuperar el objeto, asi que se marca para revision
     en vez de reventar el documento entero contra el proveedor. */
  assert.equal(out.confidence, 0);
  assert.match(out.extractionError, /invalid JSON/);
});

test('handles a reply that is not JSON at all as a review line', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider("I'm sorry, but I couldn't find a receipt.");
  const out = await extractReceipt('x');
  assert.equal(out.confidence, 0);
  assert.match(out.extractionError, /invalid JSON/);
});

test('normalises a total that came back as "$1,250.50"', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider(JSON.stringify({ ...VALID, total: '$1,250.50' }));
  const out = await extractReceipt('x');
  assert.equal(out.total, 1250.5);
});

test('normalises a European total "1.250,50 €"', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider(JSON.stringify({ ...VALID, total: '1.250,50' }));
  const out = await extractReceipt('x');
  assert.equal(out.total, 1250.5);
});

test('normalises the category even if the model uppercased it', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider(JSON.stringify({ ...VALID, category: 'MEALS' }));
  const out = await extractReceipt('x');
  assert.equal(out.category, 'meals');
});

test('rejects a date that does not exist', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider(JSON.stringify({ ...VALID, date: '2026-02-31' }));
  const out = await extractReceipt('x');
  assert.equal(out.date, null);
  assert.equal(out.confidence, 0, 'una linea con datos malos debe ir a revision');
});

test('rejects a confidence that came back as the word "high"', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider(JSON.stringify({ ...VALID, confidence: 'high' }));
  const out = await extractReceipt('x');
  assert.equal(out.confidence, 0);
  assert.match(out.extractionError, /confidence/);
});

test('a 429 from the provider throws a clear retryable error', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider('', { status: 429, statusText: 'Too Many Requests' });
  await assert.rejects(() => extractReceipt('x'), /transient, worth retrying/);
});

test('a 400 from the provider is not marked as retryable', async () => {
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  fakeProvider('', { status: 400, statusText: 'Bad Request' });
  await assert.rejects(() => extractReceipt('x'), /400 Bad Request(?!.*worth retrying)/);
});

test('without a configured key it fails before making a request', async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not reach the network'); };
  config.llmApiKey = '';
  const { extractReceipt } = await import(`../src/llm.js?${Date.now()}`);
  await assert.rejects(() => extractReceipt('x'), /LLM_API_KEY is not set/);
  assert.equal(fetchCalled, false);
});