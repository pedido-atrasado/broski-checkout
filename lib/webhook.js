import crypto from 'node:crypto';

export const TOLERANCE_SECONDS = 300;

/**
 * Verifica "Broski-Signature: t=<unix>,v1=<hex>".
 * esperado = HMAC-SHA256(secret, t + "." + corpo_cru), comparado em tempo constante.
 * rawBody TEM de ser os bytes crus, antes de qualquer parse de JSON.
 */
export function verifySignature(rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signatureHeader || !secret) return { ok: false, reason: 'missing_signature_or_secret' };

  let t = null, v1 = null;
  for (const part of String(signatureHeader).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1 = v;
  }
  if (!t || !v1) return { ok: false, reason: 'malformed_signature' };
  if (!/^\d+$/.test(t)) return { ok: false, reason: 'malformed_timestamp' };

  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(t + '.', 'utf8'), body]))
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
