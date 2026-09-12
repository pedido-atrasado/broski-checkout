import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as broski from './lib/broski.js';
import { verifySignature } from './lib/webhook.js';

// Troca esta linha para migrar de JSON para Postgres. Mais nada muda.
//   import * as store from './lib/store.pg.js';
import * as store from './lib/store.js';
import * as mailer from './lib/mailer.js';

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Webhook ANTES do express.json(): precisa do corpo CRU para a assinatura.
// ---------------------------------------------------------------------------
app.post('/webhooks/broski', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const check = verifySignature(req.body, req.get('Broski-Signature'), process.env.BROSKI_WEBHOOK_SECRET);
  if (!check.ok) {
    console.warn('[webhook] assinatura rejeitada:', check.reason);
    return res.status(400).json({ error: check.reason });
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  // Responde 2xx primeiro (limite de 10s), processa depois.
  res.status(200).json({ received: true });

  setImmediate(async () => {
    let claimed = false;
    try {
      if (await store.seenEvent(event.id)) return;      // at-least-once
      claimed = true;

      const obj = event?.data?.object;
      if (obj?.object !== 'order') return;              // payout/dispute: ignora aqui

      const rec = await store.applyOrderObject(obj);    // confia no STATUS, nao no type
      if (!rec) return console.warn('[webhook] pedido desconhecido', obj.id);

      // A decisao de entregar e a PROPRIA linha do UPDATE, nao uma leitura anterior:
      // com dois order.paid simultaneos ambos leem fulfilled:false e entram no if.
      // markFulfilled devolve true so a um deles — um recibo, nao dois.
      if (obj.status === 'paid' && await store.markFulfilled(rec)) {
        console.log(`[entrega] ${rec.external_reference} liberado — €${(store.netAmount(rec) / 100).toFixed(2)}`);
        mailer.enviarRecibo(rec).catch((e) => console.error('[email] recibo falhou:', e.message));
      }
      if (obj.status === 'refunded') console.log(`[estorno total] ${rec.external_reference}`);
    } catch (err) {
      console.error('[webhook] falha ao processar', err);
      // Solta a marca do evento para que o retry da Broski (24h) possa reprocessar.
      // Sem isto, um erro transitorio marca o evento como visto e a entrega perde-se.
      if (claimed) await store.forgetEvent(event.id).catch(() => {});
    }
  });
});

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// ---------------------------------------------------------------------------
// Catalogo do lado do servidor — o valor NUNCA vem do browser.
// amount em centimos, sempre inteiro. Euro: MB WAY e Multibanco liquidam em EUR.
// ---------------------------------------------------------------------------
const CATALOG = {
  'doacao-30':   { amount: 3000,   description: 'Doação — 12 dias de medicação para dor',                                  product_type: 'digital' },
  'doacao-50':   { amount: 5000,   description: 'Doação — 19 dias de medicação para dor',                                  product_type: 'digital' },
  'doacao-100':  { amount: 10000,  description: 'Doação — 20 dias de pensos especiais',                                    product_type: 'digital' },
  'doacao-250':  { amount: 25000,  description: 'Doação — 30 dias de medicação, pensos especiais e refeições',             product_type: 'digital' },
  'doacao-500':  { amount: 50000,  description: 'Doação — 60 dias de medicação, pensos especiais e refeições',             product_type: 'digital' },
  'doacao-1000': { amount: 100000, description: 'Doação — 120 dias de medicação, pensos especiais e refeições',            product_type: 'digital' },
};

// Valor personalizado: nao cabe no CATALOG (amount fixo por SKU), por isso tem
// rota propria com limites validados AQUI. Minimo 50 = piso da Broski (€0,50).
const LIVRE = {
  sku: 'doacao-livre',
  min: 100,          // €1,00
  max: 500000,       // €5.000,00 — ajusta ao teu risco/limite bancario
  description: 'Doação — valor personalizado',
  product_type: 'digital',
};

/** Resolve o item a cobrar. Devolve { item } ou { error, message, status }. */
function resolveItem(sku, rawAmount) {
  if (sku === LIVRE.sku) {
    const amount = Number(rawAmount);
    if (!Number.isInteger(amount)) {
      return { error: 'valor_invalido', message: 'Indique um valor válido.' };
    }
    if (amount < LIVRE.min || amount > LIVRE.max) {
      return {
        error: 'valor_fora_do_intervalo',
        message: `O valor tem de estar entre €${(LIVRE.min / 100).toFixed(2).replace('.', ',')} e €${(LIVRE.max / 100).toFixed(2).replace('.', ',')}.`,
      };
    }
    return { item: { amount, description: LIVRE.description, product_type: LIVRE.product_type } };
  }

  const item = CATALOG[sku];
  if (!item) return { error: 'sku_desconhecido', message: 'Escolha um valor de doação.' };
  return { item };   // amount vem SEMPRE do catalogo, ignora o que o browser mandou
}

app.post('/api/checkout', async (req, res) => {
  try {
    const { sku, amount: rawAmount, method, phone, name, email, nif, comment } = req.body || {};

    const resolved = resolveItem(sku, rawAmount);
    if (resolved.error) return res.status(400).json({ error: resolved.error, message: resolved.message });
    const item = resolved.item;

    if (!email) return res.status(400).json({ error: 'email_obrigatorio', message: 'Indique o seu e-mail.' });
    if (method !== 'mbway' && method !== 'multibanco') return res.status(400).json({ error: 'metodo_invalido' });
    if (method === 'mbway' && !broski.normalizePhone(phone)) {
      return res.status(400).json({ error: 'telemovel_invalido', message: 'Introduza um telemóvel português válido (9 dígitos).' });
    }

    // Referência e chave de idempotência derivadas do pedido da loja.
    // Nova tentativa apos failed/expired = referencia NOVA (a antiga fica ocupada para sempre).
    const orderNo = `ped-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const externalReference = orderNo;
    const idempotencyKey = `${orderNo}-v1`;

    const customer = { email };
    if (name) customer.name = name;
    if (nif) customer.nif = nif;
    if (phone && broski.normalizePhone(phone)) customer.phone = broski.normalizePhone(phone);

    await store.createLocalOrder({
      externalReference,
      amount: item.amount,
      method,
      customer,
      description: item.description,
      comment: typeof comment === 'string' ? comment.slice(0, 500) : null,
    });

    const { data: order } = await broski.createOrder({
      amount: item.amount,                       // do servidor, sempre
      method,
      phone,
      externalReference,
      checkoutUrl: `${PUBLIC_URL}/`,
      customer,
      description: item.description,
      productType: item.product_type,
      idempotencyKey,
    });

    const rec = await store.attachBroskiOrder(externalReference, order);

    // Voucher Multibanco: e a unica copia da referencia que o doador tem.
    // Fora do await da resposta — um SMTP lento nao pode atrasar o checkout,
    // e uma falha de e-mail nao pode anular um pedido ja criado na Broski.
    if (rec?.method === 'multibanco' && rec.multibanco) {
      mailer.enviarVoucher(rec).catch((e) => console.error('[email] voucher falhou:', e.message));
    }

    // Devolve ao browser SO o necessario.
    res.status(201).json({
      ref: externalReference,
      status: order.status,
      method: order.method,
      amount: order.amount,
      multibanco: order.multibanco || null,
      description: item.description,
    });
  } catch (err) {
    if (err instanceof broski.BroskiError) {
      // 409 mbway_pending_for_phone NAO e falha de pagamento: mostrar a message tal e qual.
      const status = err.code === 'mbway_pending_for_phone' ? 409 : err.status;
      if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
      return res.status(status).json({
        error: err.code, message: err.message, retry_after_seconds: err.retryAfterSeconds,
      });
    }
    console.error(err);
    res.status(400).json({ error: 'pedido_invalido', message: err.message });
  }
});

// O browser faz polling DESTE endpoint — nunca da API Broski.
app.get('/api/orders/:ref/status', async (req, res) => {
  const rec = await store.getByRef(req.params.ref);
  if (!rec) return res.status(404).json({ error: 'nao_encontrado' });

  // Fallback pontual: 1 consulta se o webhook nao chegou em ~60s e o pedido ainda esta pendente.
  // A marca vai para a BASE DE DADOS (fallback_at), nao para o objeto em memoria: com Postgres
  // cada leitura devolve um registo novo, e uma flag em memoria dispararia um GET por cada poll.
  const idleMs = Date.now() - new Date(rec.updated_at).getTime();
  if (rec.broski_id && rec.status === 'pending' && idleMs > 60_000 && !rec.fallback_at) {
    const claimed = await store.claimFallback(rec.external_reference);
    if (claimed) {
      try {
        const { data } = await broski.getOrder(rec.broski_id);
        const fresh = await store.applyOrderObject(data);
        if (fresh) Object.assign(rec, fresh);
      } catch (e) { console.warn('[fallback] GET falhou:', e.message); }
    }
  }

  res.json({
    ref: rec.external_reference,
    status: rec.status,
    fulfilled: rec.fulfilled,
    amount: rec.amount,
    amount_refunded: rec.amount_refunded,
    multibanco: rec.multibanco,
  });
});

app.post('/api/orders/:ref/refund', async (req, res) => {
  const rec = await store.getByRef(req.params.ref);
  if (!rec?.broski_id) return res.status(404).json({ error: 'nao_encontrado' });
  try {
    const { data } = await broski.refundOrder(rec.broski_id, {
      amount: req.body?.amount,
      reason: req.body?.reason,
      idempotencyKey: `refund-${rec.external_reference}-${req.body?.seq || 1}`,
    });
    // Estorno PARCIAL nao muda status nem gera webhook — reconciliar via GET.
    const { data: fresh } = await broski.getOrder(rec.broski_id);
    await store.applyOrderObject(fresh);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code, message: err.message });
  }
});

await store.init?.();

app.listen(PORT, () => {
  console.log(`Checkout em ${PUBLIC_URL}`);
  console.log(`Webhook  em ${PUBLIC_URL}/webhooks/broski`);
  if (!process.env.BROSKI_SECRET_KEY) console.warn('⚠  BROSKI_SECRET_KEY não definida — só o front funciona.');
});
