import fs from 'node:fs';
import config from './config.js';
import * as db from './db.js';
import { extractReceipt } from './llm.js';

const queue = [];
let running = 0;

export function enqueue(documentId) {
  queue.push(documentId);
}

export function startWorker() {
  const timer = setInterval(() => {
    while (running < config.workerConcurrency && queue.length > 0) {
      const id = queue.shift();
      running++;
      processDocument(id).catch((err) => console.error('worker crashed on', id, err)).finally(() => running--);
    }
  }, 500);
  /* El timer no debe mantener vivo el proceso por si solo: es el servidor HTTP
     el que lo hace. Sin esto, cerrar el servidor en tests deja el proceso
     colgado para siempre. */
  timer.unref();
}

async function processDocument(id) {
  const started = await db.update((data) => {
    const doc = data.documents[id];
    if (!doc) return false;
    doc.status = 'processing';
    delete doc.error;
    /* Un reintento vuelve a leer el escaneo entero, asi que las paginas de la
       pasada anterior se descartan. Sin esto se apilan encima y el informe
       acaba con el mismo recibo contado dos veces. */
    doc.pages = [];
    delete doc.progress;
    return true;
  });
  if (!started) return;

  try {
    const filePath = (await db.update((data) => data.documents[id]?.filePath)) || '';
    const text = fs.readFileSync(filePath, 'utf8');
    const pages = text.split('\f');

    for (let i = 0; i < pages.length; i++) {
      const pageText = pages[i].trim();
      if (!pageText) continue;

      let result;
      try {
        result = await extractReceipt(pageText);
      } catch (err) {
        /* Una pagina que no se puede extraer (timeout, proveedor caido, rate
           limit) marca el documento como failed y para. El employed puede
           reintentarlo desde la UI. */
        await markFailed(id, err);
        return;
      }

      /* Recargamos antes de anadir la pagina: mientras esperabamos al LLM,
         otro worker pudo haber guardado su propia pagina en el mismo fichero.
         Escribir sobre la copia en memoria la habria perdido. */
      await db.update((data) => {
        const doc = data.documents[id];
        if (!doc) return;
        doc.pages.push({ pageNumber: doc.pages.length + 1, text: pageText, ...result });
        doc.progress = `${i + 1}/${pages.length}`;
      });
    }

    await db.update((data) => {
      const doc = data.documents[id];
      if (doc) doc.status = 'done';
    });
    console.log('finished document', id);
  } catch (err) {
    /* Cualquier otro fallo (fichero borrado, disco lleno) tambien deja el
       documento en failed, nunca en processing para siempre. */
    await markFailed(id, err);
  }
}

/* Antes el catch dejaba el documento en "processing" eterno con un error
   colgado: la UI lo pintaba en naranja y parecia que seguia trabajando. */
async function markFailed(id, err) {
  console.error('error processing document', id, err);
  await db.update((data) => {
    const doc = data.documents[id];
    if (!doc) return;
    doc.status = 'failed';
    doc.error = err.message;
  });
}