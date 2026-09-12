import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// O store resolve data/orders.json a partir de process.cwd(), por isso o teste
// corre numa pasta temporaria e nao toca no orders.json real.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-'));
process.chdir(tmp);

const store = await import('../lib/store.js');

const REF = 'ped-teste-1';

before(async () => { await store.init(); });

beforeEach(async () => {
  await fs.rm(path.join(tmp, 'data'), { recursive: true, force: true });
  await store.init();
  await store.createLocalOrder({
    externalReference: REF, amount: 5000, method: 'mbway',
    customer: { email: 'a@b.pt' }, description: 'Doação', comment: null,
  });
  await store.attachBroskiOrder(REF, { id: 'ord_1', status: 'pending' });
});

test('init cria a pasta data/ e carrega o ficheiro', async () => {
  const rec = await store.getByRef(REF);
  assert.equal(rec.external_reference, REF);
  await assert.doesNotReject(fs.access(path.join(tmp, 'data', 'orders.json')));
});

test('seenEvent devolve false na 1a chamada e true na 2a', async () => {
  assert.equal(await store.seenEvent('evt_a'), false);
  assert.equal(await store.seenEvent('evt_a'), true);
  assert.equal(await store.seenEvent('evt_a'), true);
});

test('forgetEvent permite reprocessar', async () => {
  assert.equal(await store.seenEvent('evt_b'), false);
  assert.equal(await store.seenEvent('evt_b'), true);
  await store.forgetEvent('evt_b');
  assert.equal(await store.seenEvent('evt_b'), false, 'o retry tem de poder reprocessar');
});

test('claimFallback devolve true so uma vez em 5 chamadas paralelas', async () => {
  const r = await Promise.all(Array.from({ length: 5 }, () => store.claimFallback(REF)));
  assert.equal(r.filter(Boolean).length, 1, `esperado 1 true, obtido ${r.filter(Boolean).length}`);
  assert.equal(await store.claimFallback(REF), false);
});

test('claimFallback devolve false para referencia inexistente', async () => {
  assert.equal(await store.claimFallback('nao-existe'), false);
});

test('markFulfilled e idempotente', async () => {
  const rec = await store.getByRef(REF);
  assert.equal(await store.markFulfilled(rec), true);
  assert.equal(await store.markFulfilled(rec), false);
  const r = await Promise.all(Array.from({ length: 5 }, () => store.markFulfilled(rec)));
  assert.equal(r.filter(Boolean).length, 0);
  assert.equal((await store.getByRef(REF)).fulfilled, true);
});

test('markFulfilled entrega exatamente uma vez em paralelo', async () => {
  const rec = await store.getByRef(REF);
  const r = await Promise.all(Array.from({ length: 5 }, () => store.markFulfilled(rec)));
  assert.equal(r.filter(Boolean).length, 1);
});

test('netAmount = amount - amount_refunded', async () => {
  const rec = await store.getByRef(REF);
  assert.equal(store.netAmount(rec), 5000);
  await store.applyOrderObject({ id: 'ord_1', status: 'paid', amount_refunded: 1500 });
  assert.equal(store.netAmount(await store.getByRef(REF)), 3500);
});

test('applyOrderObject nunca diminui amount_refunded', async () => {
  await store.applyOrderObject({ id: 'ord_1', status: 'paid', amount_refunded: 2000 });
  await store.applyOrderObject({ id: 'ord_1', status: 'paid', amount_refunded: 500 });  // evento atrasado
  assert.equal((await store.getByRef(REF)).amount_refunded, 2000);
});

test('applyOrderObject nunca faz paid voltar a pending', async () => {
  await store.applyOrderObject({ id: 'ord_1', status: 'paid' });
  await store.applyOrderObject({ id: 'ord_1', status: 'pending' });   // evento fora de ordem
  assert.equal((await store.getByRef(REF)).status, 'paid');
  await store.applyOrderObject({ id: 'ord_1', status: 'refunded' });  // este pode avancar
  assert.equal((await store.getByRef(REF)).status, 'refunded');
});

test('applyOrderObject devolve null para broski_id desconhecido', async () => {
  assert.equal(await store.applyOrderObject({ id: 'ord_nao_existe', status: 'paid' }), null);
});

test('createLocalOrder guarda o campo comment', async () => {
  await store.createLocalOrder({
    externalReference: 'ped-com-msg', amount: 3000, method: 'multibanco',
    customer: { email: 'c@d.pt' }, description: 'Doação', comment: 'Força!',
  });
  assert.equal((await store.getByRef('ped-com-msg')).comment, 'Força!');
});

test('escritas simultaneas nao se perdem no ficheiro', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.createLocalOrder({
    externalReference: `par-${i}`, amount: 100 + i, method: 'mbway',
    customer: { email: `p${i}@x.pt` }, description: 'Doação',
  })));
  const disco = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'orders.json'), 'utf8'));
  assert.equal(Object.keys(disco.byRef).filter(k => k.startsWith('par-')).length, 20);
});
