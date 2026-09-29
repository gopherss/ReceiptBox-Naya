# NOTAS DE LOS CAMBIOS

Cambios realizados sobre la base `13da524` (no commiteados).

- **`src/config.js`**: la API key ya no tiene valor por defecto; se lee de
  `LLM_API_KEY` y se lanza un error claro si falta. Limites nuevos:
  `maxUploadBytes` (50 MB), `maxAskBytes` (8 KB) y `llmTimeoutMs` (30 s).
- **`src/server.js`**:
  - `displayName()` sanitiza el nombre del cliente y se guarda cada escaneo con
    un uuid: la escritura no puede salir de `data/uploads/`.
  - `readBody()` acumula Buffers (O(n)) y aplica los limites con 413; cuerpos
    vacios dan 400.
  - try/catch global sobre el manejador: da 500 generico (detalle al log) en
    vez de tumbar el proceso.
  - `retry` de un documento inexistente da 404; `ask` con JSON invalido o sin
    `question` da 400.
  - Se exporta el `server` para que los tests de integracion puedan cerrarlo.
- **`src/db.js`**: `update()` serializa las escrituras en una cadena de
  promesas y recarga antes de mutar (elimina el Lost Update), y `writeAtomic()`
  (temp + rename) evita dejar el `db.json` truncado. `load()` tolera `db.json`
  corrupto arrancando con una base vacia.
- **`src/worker.js`**: cada paso usa `db.update()`; si una pagina falla el
  documento pasa a `status: 'failed'` (estado nuevo) con su error; un retry
  descarta las paginas anteriores; el timer del worker esta `unref()`.
- **`src/llm.js`**: `AbortSignal.timeout()`; comprobacion de `res.ok` con
  conjuntos de estados reintentables (408/429/500/502/503/504/529); `parseReply`
  tolera fences/prosa/truncamiento; `parseAmount`, `parseDate` y `normalise`
  validan lo que devuelve el modelo (resultados de confianza 0 marcados para
  revision); un JSON irrecuperable ya no tira el documento, lo marca.
- **`src/assistant.js`**: el payload de `ask` contiene solo datos estructurados
  (nunca `page.text`), de modo que la inyeccion del recibo no llega al LLM;
  las preguntas sugeridas son null-safe; los errores del proveedor van al log y
  el cliente recibe un mensaje generico.
- **`package.json`**: `npm test` vuelve a funcionar
  (`node --test test/*.test.js`).
- **Tests**: `test/db.test.js` (5), `test/llm.test.js` (13),
  `test/assistant.test.js` (6) y `test/api.test.js` (9, integracion con
  servidor real y sandbox fake en puerto libre/tmp).