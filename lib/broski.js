// Cliente da API Broski. Roda SOMENTE no servidor — a sk_live_ nunca sai daqui.
const BASE = process.env.BROSKI_BASE_URL || 'https://api.broski.pt';

export class BroskiError extends Error {
  constructor(status, body, retryAfter) {
    const e = body?.error || {};
    super(e.message || `Broski HTTP ${status}`);
    this.name = 'BroskiError';
    this.status = status;
    this.type = e.type || 'api_error';
    this.code = e.code || 'unknown';
    this.param = e.param;
    // O 429 nao traz Retry-After; so o 409 mbway_pending_for_phone traz.
    this.retryAfterSeconds = e.retry_after_seconds ?? retryAfter ?? null;
  }
}

function key() {
  const k = process.env.BROSKI_SECRET_KEY;
  if (!k) throw new Error('BROSKI_SECRET_KEY em falta no ambiente.');
  return k;
}

async function request(method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${key()}`, Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    // Serializa explicitamente em UTF-8: byte fora de UTF-8 -> 400 invalid_encoding.
    payload = Buffer.from(JSON.stringify(body), 'utf8');
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const ra = res.headers.get('retry-after');
    throw new BroskiError(res.status, json, ra ? Number(ra) : null);
  }
  return { data: json, replay: res.headers.get('idempotent-replay') === 'true' };
}

// Backoff exponencial apenas para 429 (limite de 120 req/min por chave, GLOBAL).
async function withBackoff(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof BroskiError) || err.status !== 429 || i >= tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 250));
    }
  }
}

/** Telemovel PT -> "+3519XXXXXXXX". Aceita "912345678", "912 345 678", "+351...". */
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/[\s\-().]/g, '');
  const nat = d.startsWith('+351') ? d.slice(4) : d.startsWith('351') && d.length === 12 ? d.slice(3) : d;
  if (!/^9[1236]\d{7}$/.test(nat)) return null; // 2o digito 1/2/3/6
  return '+351' + nat;
}

export const MBWAY_MIN = 50;      // €0,50
export const MBWAY_MAX = 500000;  // €5.000

/**
 * POST /v1/orders — envia SOMENTE campos documentados (campo desconhecido -> 400).
 */
export function createOrder({
  amount, method, phone, externalReference, checkoutUrl,
  customer, description, productType, idempotencyKey,
}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount tem de ser inteiro em cêntimos.');
  if (method !== 'mbway' && method !== 'multibanco') throw new Error('method: "mbway" | "multibanco".');
  if (!externalReference) throw new Error('external_reference obrigatório.');
  if (!checkoutUrl) throw new Error('checkout_url obrigatório.');
  if (!customer?.email) throw new Error('customer.email obrigatório.');
  if (!idempotencyKey) throw new Error('Idempotency-Key obrigatória.');

  const body = {
    amount,
    method,
    external_reference: externalReference,
    checkout_url: checkoutUrl,
    customer,
  };
  if (description) body.description = description.slice(0, 140);
  if (productType) body.product_type = productType;

  if (method === 'mbway') {
    if (amount < MBWAY_MIN || amount > MBWAY_MAX) throw new Error('MB WAY aceita €0,50 a €5.000.');
    const p = normalizePhone(phone);
    if (!p) throw new Error('Telemóvel português inválido.');
    body.phone = p;
  }
  // currency omitida de propósito (recomendado pelas docs).

  return withBackoff(() => request('POST', '/v1/orders', { body, idempotencyKey }));
}

/** Fallback pontual — NUNCA usar para polling de checkout. */
export function getOrder(id) {
  return withBackoff(() => request('GET', `/v1/orders/${encodeURIComponent(id)}`));
}

export function listOrders(params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  return withBackoff(() => request('GET', `/v1/orders${q ? '?' + q : ''}`));
}

/** Corpo JSON obrigatório: {} = total; {amount, reason} = parcial. */
export function refundOrder(id, { amount, reason, idempotencyKey } = {}) {
  if (!idempotencyKey) throw new Error('Idempotency-Key obrigatória no estorno.');
  const body = {};
  if (amount) body.amount = amount;
  if (reason) body.reason = reason;
  return withBackoff(() =>
    request('POST', `/v1/orders/${encodeURIComponent(id)}/refunds`, { body, idempotencyKey }),
  );
}
