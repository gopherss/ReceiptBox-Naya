import { test } from 'node:test';
import assert from 'node:assert';
import { SUGGESTED } from '../src/assistant.js';

/* El LLM no es de fiar: puede devolver total:null o confidence:null para un
   recibo que no entendio. Las preguntas sugeridas se responden en codigo y no
   deben reventar por eso (antes, el biggest expense hacia toFixed() sobre null
   y tiraba un TypeError que el servidor capturaba como 500). */

const line = (over = {}) => ({
  filename: 'trip.txt',
  pageNumber: 1,
  merchant: 'Lumen Coffee Co.',
  date: '2026-03-09',
  total: 18.4,
  currency: 'USD',
  category: 'meals',
  confidence: 0.87,
  ...over,
});

test('total to reimburse ignores lines with no usable total', () => {
  const out = SUGGESTED['What is my total to reimburse?'](
    [line({ total: 18.4 }), line({ total: null }), line({ total: 'not a number' })],
  );
  assert.match(out, /\*\*\$18\.4\*\* across 3 receipts/);
});

test('biggest expense survives every line having a null total', () => {
  const out = SUGGESTED['What was my biggest expense?']([line({ total: null }), line({ total: null })]);
  assert.match(out, /no expenses with a valid amount/);
});

test('biggest expense picks the largest midnight total', () => {
  const out = SUGGESTED['What was my biggest expense?'](
    [line({ total: 10, merchant: 'Small' }), line({ total: 400.68, merchant: 'The Parkside Hotel', date: '2026-03-09' })],
  );
  assert.match(out, /The Parkside Hotel/);
  assert.match(out, /\$400\.68/);
});

test('receipts that need review survive a null merchant', () => {
  const out = SUGGESTED['Which receipts need review?'](
    [line({ confidence: 0.4, merchant: null }), line({ confidence: 0.9 })],
  );
  assert.match(out, /1 receipt\(s\)/);
  assert.match(out, /Unknown/, 'no debe imprimir null como merchant');
});

test('none need review when all are confident', () => {
  const out = SUGGESTED['Which receipts need review?']([line()]);
  assert.match(out, /Nothing needs review/);
});

test('meals filter uses the normalised category', () => {
  const out = SUGGESTED['How much did I spend on meals?'](
    [line({ category: 'meals', total: 18.4 }), line({ category: 'lodging', total: 400.68 })],
  );
  assert.match(out, /\*\*\$18\.4\*\* on meals \(1 receipts\)/);
});