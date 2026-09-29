import config from './config.js';

const PROMPT = `You are helping an employee fill in an expense report.
The page below is one scanned receipt. Extract:

- merchant: the name of the business
- date: the date of the purchase as YYYY-MM-DD
- total: the total amount paid, as a number (e.g. 1250.5)
- currency: the three-letter currency code, e.g. USD
- category: exactly one of meals, travel, lodging, office, software, other
- confidence: a number between 0 and 1

Respond with JSON only, in this shape:
{"merchant": "...", "date": "...", "total": 0, "currency": "...", "category": "...", "confidence": 0}

Receipt:
`;

/* El proveedor responde a veces 429/500/529 y a veces tarda 180 s. Distinguimos
   los errores que se arreglan reintentando de los que no, para que el worker
   pueda dar un mensaje util en vez de "algo fue mal". */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

async function callLLM(system, messages, maxTokens) {
  if (!config.llmApiKey) {
    throw new Error('LLM_API_KEY is not set, so receipts cannot be read');
  }

  const res = await fetch(config.llmUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
    /* Sin esto, una llamada colgada mantiene el worker ocupado para siempre. */
    signal: AbortSignal.timeout(config.llmTimeoutMs),
  }).catch((err) => {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`the AI provider did not answer within ${config.llmTimeoutMs} ms (transient, worth retrying)`);
    }
    throw err;
  });

  /* Antes se hacia body.content[0].text a ciegas: un 429 del proveedor daba
     "Cannot read properties of undefined" en vez de un mensaje util. */
  if (!res.ok) {
    const retry = RETRYABLE.has(res.status) ? ' (transient, worth retrying)' : '';
    throw new Error(`LLM provider returned ${res.status} ${res.statusText}${retry}`);
  }

  const body = await res.json();
  const text = body?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('LLM provider returned no text');
  return text;
}

/* El proveedor no siempre devuelve JSON puro: a veces lo envuelve en un fence
   de markdown, a veces le pone texto antes, y a veces lo trunca. Antes de
   JSON.parse a pelo, estos casos devolvian una excepcion que tumbaba el
   documento entero. Aqui se saca el objeto que se pueda. */
function parseReply(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : reply).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* Ultimo intento: el primer objeto JSON completo que haya en la respuesta. */
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {}
    }
    throw new Error('invalid JSON in LLM reply');
  }
}

const CATEGORIES = new Set(['meals', 'travel', 'lodging', 'office', 'software', 'other']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/* Acepta 1250.5, "1250.5", "$1,250.50" y "1.250,50" (formato europeo). */
function parseAmount(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[^\d.,-]/g, '').trim();
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    /* Formato europeo: 1.250,50 -> los puntos son separadores de millares. */
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* Acepta YYYY-MM-DD, MM/DD/YYYY y "Mar 9, 2026". Rechaza fechas imposibles
   como 2026-02-31, que el modelo inventa a menudo. */
function parseDate(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isRealDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return isRealDate(+yyyy, +mm, +dd) ? `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}` : null;
  }
  m = s.match(/^([A-Za-z]{3,})\w*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (month > 0 && isRealDate(+m[3], month, +m[2])) {
      return `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
  }
  return null;
}

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/* El modelo no es de fiar con los tipos: devuelve 18.4 como "$18.40", la
   categoria en mayusculas, o confidence: "high". Aqui se normaliza y, si
   algun campo no se puede usar, la linea se marca para revision con
   confidence 0 en vez de colarse en el informe como si fuera buena. */
function normalise(raw) {
  const out = {
    merchant: null, date: null, total: null,
    currency: null, category: null, confidence: 0, extractionError: null,
  };
  const problems = [];

  if (typeof raw?.merchant === 'string' && raw.merchant.trim()) out.merchant = raw.merchant.trim();
  else problems.push('merchant is missing');

  out.date = parseDate(raw?.date);
  if (!out.date) problems.push('date is unusable');

  out.total = parseAmount(raw?.total);
  if (out.total === null) problems.push('total is not a number');

  if (typeof raw?.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency.trim())) {
    out.currency = raw.currency.trim().toUpperCase();
  } else {
    problems.push('currency is not a 3-letter code');
  }

  if (typeof raw?.category === 'string') {
    const c = raw.category.trim().toLowerCase();
    if (CATEGORIES.has(c)) out.category = c;
    else problems.push('category is not one of meals, travel, lodging, office, software, other');
  } else {
    problems.push('category is not a string');
  }

  const conf = typeof raw?.confidence === 'number' ? raw.confidence : Number(raw?.confidence);
  if (Number.isFinite(conf)) out.confidence = Math.min(1, Math.max(0, conf));
  else problems.push('confidence is not a number');

  /* Si un campo no sirve, la confianza de la linea entera es 0: asi "Which
     receipts need review?" la senala aunque el resto haya salido bien. */
  if (problems.length) {
    out.confidence = 0;
    out.extractionError = problems.join('; ');
  }
  return out;
}

export async function extractReceipt(text) {
  const reply = await callLLM(undefined, [{ role: 'user', content: PROMPT + text }], 200);
  try {
    return normalise(parseReply(reply));
  } catch {
    /* No tiramos el documento: devolvemos una linea vacia marcada para revision,
       que el empleado vera en "Which receipts need review?". */
    return {
      merchant: null, date: null, total: null, currency: null,
      category: null, confidence: 0, extractionError: 'invalid JSON in LLM reply',
    };
  }
}

export async function chat(system, messages) {
  return callLLM(system, messages, 500);
}
