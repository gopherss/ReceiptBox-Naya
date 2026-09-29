import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

/* Un JSON corrupto no debe impedir arrancar: si no se puede leer se devuelve
   una base vacia, se avisa por el log, y el siguiente guardado lo sobrescribira.
   Es lo menos malo cuando no hay copia de seguridad. */
export function load() {
  if (!fs.existsSync(config.dbPath)) {
    return { documents: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(config.dbPath, 'utf8'));
  } catch (err) {
    console.error(`could not read ${config.dbPath}, starting from an empty database: ${err.message}`);
    return { documents: {} };
  }
}

/* Escritura atomica: se escribe a un temporal y se renombra. rename es atomico
   en el mismo sistema de ficheros, asi que un corte a mitad de escritura deja
   el db.json viejo intacto en vez de un JSON truncado que ya no arranca. */
function writeAtomic(data) {
  const tmp = `${config.dbPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, config.dbPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/* El fallo de fondo eran las escrituras load() -> mutar -> save() con 4 workers
   en paralelo: cada uno guardaba su copia entera y se pisaban entre si. Aqui
   las escrituras se encadenan en una promesa, de forma que solo una esta
   escribiendo a la vez. */
let chain = Promise.resolve();

/* La forma correcta de escribir: recarga, aplica el cambio y guarda, todo en un
   solo turno de la cadena. Recargar antes de mutar es lo que evita el Lost
   Update, porque el mutador ve lo que otro worker acaba de guardar. */
export function update(mutator) {
  chain = chain.then(async () => {
    const data = load();
    const result = mutator(data);
    writeAtomic(data);
    return result;
  });
  return chain;
}