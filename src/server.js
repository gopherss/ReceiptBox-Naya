import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import * as db from './db.js';
import { enqueue, startWorker } from './worker.js';
import { ask, SUGGESTED } from './assistant.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/* Lee el body con tope duro: una subida de 600 MB (el sample que genera el
   README) ya no se carga entera en memoria. Concatenar strings (data += chunk)
   era O(n^2) en copias; acumular Buffers es O(n). */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      const err = new Error(`request too large: limit is ${humanSize(maxBytes)}`);
      err.statusCode = 413;
      return reject(err);
    }

    const chunks = [];
    let size = 0;
    let over = false;

    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        chunks.length = 0;
        const err = new Error(`request too large: limit is ${humanSize(maxBytes)}`);
        err.statusCode = 413;
        return reject(err);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/* El nombre que envia el cliente es SOLO una etiqueta de la UI: nunca se usa
   como ruta en disco. Cada escaneo se guarda con un uuid que generamos,
   asi que nada de lo que envie el cliente puede sacar la escritura fuera de
   data/uploads/. Antes, filename=../../evil.txt escribia en la raiz del repo. */
function displayName(raw) {
  const cleaned = String(raw || '')
    .split(/[\\/]/).pop()              /* quita cualquier ruta */
    .replace(/[\x00-\x1f\x7f]/g, '')   /* quita caracteres de control */
    .trim()
    .slice(0, 200);
  return cleaned || 'untitled.txt';
}

/* El manejador es async: sin este try/catch, un throw en cualquier ruta se
   convierte en una promesa rechazada sin consumidor y tumba el proceso. */
const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    console.error('unhandled error in', req.method, req.url, err);
    if (res.headersSent) return res.end();
    /* El detalle del error va al log del servidor, no al cliente: un stack
       trace o una ruta de fichero no le dicen nada util a un empleado. */
    return send(res, 500, { error: 'internal server error' });
  }
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  console.log(req.method, url.pathname);

  // GET /   (the UI)
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync('./public/index.html'));
  }

  // GET /samples/:name   (lets the UI upload the generated sample files)
  const SAMPLES = ['weekend-trip.txt', 'sales-quarter.txt', 'conference-trip.txt'];
  if (req.method === 'GET' && parts[0] === 'samples' && SAMPLES.includes(parts[1])) {
    const samplePath = `./samples/${parts[1]}`;
    if (!fs.existsSync(samplePath)) return send(res, 404, { error: 'run "npm run samples" first' });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(samplePath));
  }

  // POST /documents?filename=foo.txt   (raw body = document text, pages separated by \f)
  if (req.method === 'POST' && url.pathname === '/documents') {
    const filename = displayName(url.searchParams.get('filename'));

    let body;
    try {
      body = await readBody(req, config.maxUploadBytes);
    } catch (err) {
      return send(res, err.statusCode || 400, { error: err.message });
    }
    if (!body.length) return send(res, 400, { error: 'empty document' });

    const id = crypto.randomUUID();
    const filePath = path.join(config.uploadDir, `${id}.txt`);
    await fs.promises.writeFile(filePath, body);

    const created = await db.update((data) => {
      data.documents[id] = {
        id,
        filename,
        filePath,
        status: 'pending',
        pages: [],
        createdAt: new Date().toISOString(),
      };
      return data.documents[id];
    });
    enqueue(id);
    return send(res, 201, created);
  }

  // GET /documents
  if (req.method === 'GET' && url.pathname === '/documents') {
    const data = db.load();
    const docs = Object.values(data.documents).map((d) => ({
      id: d.id,
      filename: d.filename,
      status: d.status,
      progress: d.progress,
      pageCount: d.pages.length,
      error: d.error,
      createdAt: d.createdAt,
    }));
    return send(res, 200, docs);
  }

  // GET /documents/:id
  if (req.method === 'GET' && parts[0] === 'documents' && parts.length === 2) {
    const data = db.load();
    const doc = data.documents[parts[1]];
    if (!doc) return send(res, 404, { error: 'not found' });
    return send(res, 200, doc);
  }

  // POST /documents/:id/retry
  if (req.method === 'POST' && parts[0] === 'documents' && parts[2] === 'retry') {
    // Antes: doc en undefined -> TypeError sin capturar -> el proceso entero moria.
    const retried = await db.update((data) => {
      const doc = data.documents[parts[1]];
      if (!doc) return false;
      doc.status = 'pending';
      return true;
    });
    if (!retried) return send(res, 404, { error: 'not found' });
    enqueue(parts[1]);
    return send(res, 202, { id: parts[1], status: 'pending' });
  }

  // GET /search?q=lumen&category=meals
  if (req.method === 'GET' && url.pathname === '/search') {
    const q = url.searchParams.get('q');
    const category = url.searchParams.get('category');
    const data = db.load();
    const results = [];
    for (const doc of Object.values(data.documents)) {
      for (const page of doc.pages) {
        const matches = category ? page.category === category : !q || page.text.includes(q);
        if (!matches) continue;
        results.push({
          documentId: doc.id,
          filename: doc.filename,
          pageNumber: page.pageNumber,
          category: page.category,
          merchant: page.merchant,
          date: page.date,
          total: page.total,
          currency: page.currency,
          snippet: page.text.slice(0, 200),
        });
      }
    }
    return send(res, 200, results);
  }

  // GET /questions   (suggested questions for the assistant)
  if (req.method === 'GET' && url.pathname === '/questions') {
    return send(res, 200, Object.keys(SUGGESTED));
  }

  // POST /ask   {"question": "..."}
  if (req.method === 'POST' && url.pathname === '/ask') {
    let question;
    try {
      ({ question } = JSON.parse(await readBody(req, config.maxAskBytes)));
    } catch (err) {
      // Antes: JSON.parse a pelo -> SyntaxError -> el proceso moria.
      return send(res, err.statusCode || 400, { error: 'could not read the request body as JSON' });
    }
    if (typeof question !== 'string' || !question.trim()) {
      return send(res, 400, { error: 'the request must include a non-empty "question" string' });
    }

    const result = await ask(question);
    return send(res, 200, result);
  }

  send(res, 404, { error: 'not found' });
}

startWorker();
server.listen(config.port, () => {
  console.log(`receiptbox listening on http://localhost:${config.port}`);
});

/* Exportamos el servidor para que los tests de integracion puedan cerrarlo. */
export { server };