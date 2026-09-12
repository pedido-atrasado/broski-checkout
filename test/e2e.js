// E2E contra o servidor local (que fala com o mock da API Broski).
const BASE = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eur = (c) => '€' + (c / 100).toFixed(2);
let falhas = 0;

function check(nome, cond, extra = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${nome}${extra ? ' — ' + extra : ''}`);
  if (!cond) falhas++;
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) };
}
const status = async (ref) => (await fetch(`${BASE}/api/orders/${ref}/status`)).json();

console.log('\n=== 1. MB WAY: pedido -> espera -> webhook order.paid ===');
const a = await post('/api/checkout', {
  sku: 'doacao-30', amount: 1, method: 'mbway', phone: '913 111 222', name: 'Rui Costa', email: 'rui@exemplo.pt',
});
check('201 criado', a.status === 201, JSON.stringify(a.body));
check('status inicial pending', a.body.status === 'pending');
check('valor do servidor (3000), nao do browser', a.body.amount === 3000, eur(a.body.amount));
check('nenhuma credencial vaza para o browser',
  !JSON.stringify(a.body).match(/sk_live|whbroski|Bearer/i));
const ref = a.body.ref;

console.log('\n=== 2. Bloqueio: mesmo telemovel, segundo pedido MB WAY ===');
const dup = await post('/api/checkout', { sku: 'doacao-50', method: 'mbway', phone: '913111222', email: 'rui@exemplo.pt' });
check('409 mbway_pending_for_phone', dup.status === 409 && dup.body.error === 'mbway_pending_for_phone');
check('Retry-After: 240 propagado', dup.retryAfter === '240', String(dup.retryAfter));
check('message do PSP intacta para o cliente', /Abra o app MB WAY/.test(dup.body.message || ''));

console.log('\n=== 3. Aguardar confirmacao na app (webhook) ===');
let s;
for (let i = 0; i < 12; i++) { await sleep(1000); s = await status(ref); if (s.status === 'paid') break; }
check('status = paid via webhook assinado', s.status === 'paid', s.status);
check('produto liberado SO no order.paid', s.fulfilled === true);
const antes = await status(ref);
check('bloqueio caiu apos pagamento',
  (await post('/api/checkout', { sku: 'doacao-100', method: 'mbway', phone: '913111222', email: 'rui@exemplo.pt' })).status === 201);

console.log('\n=== 4. Multibanco: voucher (ecra final, sem polling) ===');
const m = await post('/api/checkout', { sku: 'doacao-50', method: 'multibanco', name: 'Rui Costa', email: 'rui@exemplo.pt' });
check('201 criado', m.status === 201);
check('status awaiting_payment (normal, duradouro)', m.body.status === 'awaiting_payment', m.body.status);
const v = m.body.multibanco || {};
check('voucher tem entidade', !!v.entity, v.entity);
check('voucher tem referencia', !!v.reference, v.reference);
check('voucher tem valor', v.amount === 5000, eur(v.amount));
check('voucher tem expires_at (nao assumir dias fixos)', !!v.expires_at, v.expires_at);
console.log(`     -> Entidade ${v.entity} | Ref ${v.reference} | ${eur(v.amount)} | ate ${new Date(v.expires_at).toLocaleString('pt-PT')}`);

console.log('\n=== 5. Multibanco pago dias depois (simulado) ===');
let s2;
for (let i = 0; i < 20; i++) { await sleep(1000); s2 = await status(m.body.ref); if (s2.status === 'paid') break; }
check('order.paid tardio processado', s2.status === 'paid', s2.status);
check('entrega liberada', s2.fulfilled === true);

console.log('\n=== 6. Seguranca do webhook ===');
const forjado = await fetch(`${BASE}/webhooks/broski`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Broski-Signature': 't=' + Math.floor(Date.now()/1000) + ',v1=' + 'de'.repeat(32) },
  body: JSON.stringify({ id: 'evt_hack', type: 'order.paid', data: { object: { object: 'order', id: 'ord_x', status: 'paid' } } }),
});
check('webhook com assinatura falsa -> 400', forjado.status === 400, String(forjado.status));
const semSig = await fetch(`${BASE}/webhooks/broski`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('webhook sem assinatura -> 400', semSig.status === 400, String(semSig.status));

console.log('\n=== 7. Validacoes de entrada ===');
check('telemovel invalido -> 400', (await post('/api/checkout', { sku: 'doacao-30', method: 'mbway', phone: '942345678', email: 'a@b.pt' })).status === 400);
check('email em falta -> 400', (await post('/api/checkout', { sku: 'doacao-30', method: 'mbway', phone: '912345678' })).status === 400);
check('sku desconhecido -> 400', (await post('/api/checkout', { sku: 'gratis', method: 'mbway', phone: '912345678', email: 'a@b.pt' })).status === 400);
check('metodo invalido -> 400', (await post('/api/checkout', { sku: 'doacao-30', method: 'cartao', email: 'a@b.pt' })).status === 400);

console.log('\n=== 8. Estorno parcial (nao muda status, nao gera webhook) ===');
const rf = await post(`/api/orders/${ref}/refund`, { amount: 500, reason: 'parcial', seq: 1 });
check('201 estorno criado', rf.status === 200 || rf.status === 201, JSON.stringify(rf.body));
const s3 = await status(ref);
check('status continua "paid"', s3.status === 'paid', s3.status);
check('amount_refunded aumentou', s3.amount_refunded === 500, String(s3.amount_refunded));
check('liquido = amount - refunded', s3.amount - s3.amount_refunded === 2500, eur(s3.amount - s3.amount_refunded));
void antes;


console.log('\n=== 9. Valor personalizado (doacao-livre) ===');
const livre = await post('/api/checkout', { sku: 'doacao-livre', amount: 1234, method: 'multibanco', email: 'a@b.pt' });
check('valor livre valido -> 201', livre.status === 201, JSON.stringify(livre.body));
check('cobra exatamente o valor pedido', livre.body.amount === 1234, eur(livre.body.amount));
check('abaixo do minimo -> 400', (await post('/api/checkout', { sku: 'doacao-livre', amount: 99, method: 'multibanco', email: 'a@b.pt' })).status === 400);
check('acima do maximo -> 400', (await post('/api/checkout', { sku: 'doacao-livre', amount: 500001, method: 'multibanco', email: 'a@b.pt' })).status === 400);
check('nao inteiro -> 400', (await post('/api/checkout', { sku: 'doacao-livre', amount: 10.5, method: 'multibanco', email: 'a@b.pt' })).status === 400);
check('sem amount -> 400', (await post('/api/checkout', { sku: 'doacao-livre', method: 'multibanco', email: 'a@b.pt' })).status === 400);
check('amount negativo -> 400', (await post('/api/checkout', { sku: 'doacao-livre', amount: -5000, method: 'multibanco', email: 'a@b.pt' })).status === 400);

console.log(`\n${falhas === 0 ? 'TODOS OS CHECKS PASSARAM' : falhas + ' CHECK(S) FALHARAM'}\n`);
process.exit(falhas ? 1 : 0);
