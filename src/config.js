export default {
  port: process.env.PORT || 5000,
  llmUrl: process.env.LLM_URL || 'http://localhost:4000/v1/messages',
  /* Sin valor por defecto a proposito: una clave escrita en el repo es una clave
     que se filtra con el repo, y esta ya estaba en el historial de git. */
  llmApiKey: process.env.LLM_API_KEY || '',
  model: 'claude-haiku-4-5',
  dbPath: './data/db.json',
  uploadDir: './data/uploads',
  workerConcurrency: 4,
  /* Tope del body que se acepta en memoria. El README genera un sample de 600 MB,
     asi que sin esto una subida basta para tumbar el proceso. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 50 * 1024 * 1024,
  /* /ask solo lleva una pregunta corta, asi que su tope es mucho menor. */
  maxAskBytes: Number(process.env.MAX_ASK_BYTES) || 8 * 1024,
  /* Un recibo va a pedir al LLM; mas de 30 s sin respuesta es un fallo, no un recibo lento. */
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 30_000,
};
