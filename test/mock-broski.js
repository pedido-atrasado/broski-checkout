// Mock local da API Broski, so para provar o fluxo ponta-a-ponta sem chave real.
// NAO faz parte da integracao: em producao aponta-se BROSKI_BASE_URL para api.broski.pt.
import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.use(express.json());
const PORT = 4010;
const WEBHOOK_URL = process.env.MOCK_WEBHOOK_URL || 'http://localhost:3000/webhooks/broski';
const SECRET = process.env.BROSKI_WEBHOOK_SECRET || 'whbroski_mock';

const orders = new Map();
const idem = new Map();
const phonesPending = new Map();

const id = (p) => p + crypto.randomBytes(5).toString('hex');

async function enviarWebhook(type, order) {
  const body = JSON.stringify({
    id: id('evt_'), type, created: Math.floor(Date.now() / 1000),
    data: { object: { object: 'order', ...order } },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Broski-Signature': `t=${t},v1=${v1}` },
      body,
    });
    console.log(`[mock] webhook ${type} -> ${r.status}`);
  } catch (e) { console.error('[mock] webhook falhou', e.message); }
}

app.post('/v1/orders', async (req, res) => {
  const k = req.get('Idempotency-Key');
  if (!k) return res.status(400).json({ error: { type: 'invalid_request', code: 'validation_failed', message: 'Idempotency-Key obrigatória.' } });
  if (idem.has(k)) { res.set('Idempotent-Replay', 'true'); return res.status(201).json(idem.get(k)); }

  const b = req.body;
  if (b.method === 'mbway') {
    if (phonesPending.has(b.phone)) {
      res.set('Retry-After', '240');
      return res.status(409).json({ error: { type: 'conflict', code: 'mbway_pending_for_phone',
        message: 'Já existe um pagamento MB WAY à espera de confirmação para este número de telemóvel. Abra o app MB WAY e confirme (ou recuse) esse pagamento antes de iniciar outro. Se preferir, aguarde 4 minutos e tente de novo.',
        retry_after_seconds: 240 } });
    }
    phonesPending.set(b.phone, true);
  }

  const order = {
    id: id('ord_'),
    status: b.method === 'mbway' ? 'pending' : 'awaiting_payment',
    amount: b.amount, amount_refunded: 0, currency: 'EUR', method: b.method,
    product_type: b.product_type || 'digital', external_reference: b.external_reference,
    livemode: false, created_at: new Date().toISOString(),
  };
  if (b.method === 'multibanco') {
    order.multibanco = {
      entity: '11249',
      reference: String(Math.floor(1e8 + Math.random() * 9e8)).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'),
      amount: b.amount,
      expires_at: new Date(Date.now() + 3 * 864e5).toISOString(),
    };
  }
  orders.set(order.id, { order, phone: b.phone });
  idem.set(k, order);
  res.status(201).json(order);

  // Simula: MB WAY confirma em ~6s; Multibanco emite awaiting_payment e paga em ~12s.
  if (b.method === 'mbway') {
    setTimeout(async () => {
      phonesPending.delete(b.phone);
      order.status = 'paid'; order.paid_at = new Date().toISOString();
      await enviarWebhook('order.paid', order);
    }, 6000);
  } else {
    setTimeout(() => enviarWebhook('order.awaiting_payment', order), 500);
    setTimeout(async () => {
      order.status = 'paid'; order.paid_at = new Date().toISOString();
      await enviarWebhook('order.paid', order);
    }, 12000);
  }
});

app.get('/v1/orders/:id', (req, res) => {
  const e = orders.get(req.params.id);
  if (!e) return res.status(404).json({ error: { type: 'invalid_request', code: 'resource_not_found', message: 'Pedido não encontrado.' } });
  res.json(e.order);
});

app.post('/v1/orders/:id/refunds', (req, res) => {
  const e = orders.get(req.params.id);
  if (!e) return res.status(404).json({ error: { code: 'resource_not_found', message: 'Não encontrado.' } });
  if (e.order.status !== 'paid') return res.status(409).json({ error: { code: 'order_not_paid', message: 'Pedido não pago.' } });
  const amt = req.body?.amount || (e.order.amount - e.order.amount_refunded);
  e.order.amount_refunded += amt;
  if (e.order.amount_refunded >= e.order.amount) {
    e.order.status = 'refunded';
    enviarWebhook('order.refunded', e.order);
  }
  res.status(201).json({ id: id('ref_'), amount: amt, status: 'succeeded' });
});

app.listen(PORT, () => console.log(`[mock] API Broski falsa em http://localhost:${PORT}`));
