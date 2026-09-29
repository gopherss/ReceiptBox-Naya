import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as db from '../src/db.js';
import config from '../src/config.js';

/* Los tests escriben de verdad, asi que apuntan a un temporal y restablecen la
   ruta al terminar. Si no, "npm test" ensuciaria data/db.json real. */
const realDbPath = config.dbPath;
config.dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'receiptbox-test-')), 'db.json');

test.after(() => {
  config.dbPath = realDbPath;
  fs.rmSync(path.dirname(config.dbPath), { recursive: true, force: true });
});

test('load returns an empty database when there is no file', () => {
  assert.deepEqual(db.load(), { documents: {} });
});

test('update persists a document and returns its value', async () => {
  const saved = await db.update((data) => {
    data.documents.a = { id: 'a', pages: [] };
    return data.documents.a;
  });
  assert.equal(saved.id, 'a');
  assert.equal(db.load().documents.a.id, 'a');
});

test('concurrent updates do not lose writes', async () => {
  /* Este test reproduce el fallo: 4 workers llamando update() a la vez. Con el
     viejo load->mutar->save, cada worker escribia su copia entera y se ponia
     encima de la del otro, perdiendo documentos enteros. */
  await db.update((data) => { data.documents = {}; });
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      db.update((data) => {
        data.documents[`doc${i}`] = { id: `doc${i}`, pages: [] };
      }),
    ),
  );
  const data = db.load();
  assert.equal(Object.keys(data.documents).length, 25);
  for (let i = 0; i < 25; i++) assert.ok(data.documents[`doc${i}`], `doc${i} se perdio`);
});

test('an update sees writes made by earlier updates', async () => {
  /* El worker recarga antes de cada mutacion: si este test falla, un worker
     pisaria las paginas que guardo otro worker mientras esperaba al LLM. */
  await db.update((data) => { data.documents = {}; });
  await db.update((data) => { data.documents.first = { id: 'first', pages: [] }; });
  await db.update((data) => {
    data.documents.second = { id: 'second', pages: [] };
    assert.ok(data.documents.first, 'el segundo update no vio el primero');
  });
});

test('no partial temp file is left behind', async () => {
  await db.update((data) => { data.documents.tmp = { id: 'tmp', pages: [] }; });
  const leftovers = fs.readdirSync(path.dirname(config.dbPath)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});