import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { verifySignature } from '../lib/webhook.js';
import { normalizePhone } from '../lib/broski.js';

// VETOR DE TESTE OFICIAL das docs — tem de reproduzir exatamente.
const SECRET = 'whbroski_vetor_de_teste_nao_usar_em_producao';
const T = 1750000000;
const BODY = '{"id":"evt_teste123","type":"order.paid","created":1750000000,"data":{"object":{"id":"ord_teste123","status":"paid"}}}';
const HEADER = 't=1750000000,v1=5fb448226598b14dea45ff94ee317c2c1edd464f87cd720b0d8673ea89731d4c';

test('vetor de teste oficial da assinatura', () => {
  const r = verifySignature(Buffer.from(BODY, 'utf8'), HEADER, SECRET, T);
  assert.equal(r.ok, true, r.reason);
});

test('assinatura errada é rejeitada', () => {
  const bad = 't=1750000000,v1=' + 'a'.repeat(64);
  assert.equal(verifySignature(Buffer.from(BODY), bad, SECRET, T).ok, false);
});

test('corpo adulterado é rejeitado', () => {
  const tampered = BODY.replace('"status":"paid"', '"status":"failed"');
  assert.equal(verifySignature(Buffer.from(tampered), HEADER, SECRET, T).ok, false);
});

test('replay fora da tolerância de 300s é rejeitado', () => {
  const r = verifySignature(Buffer.from(BODY), HEADER, SECRET, T + 301);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timestamp_out_of_tolerance');
});

test('dentro da tolerância passa', () => {
  assert.equal(verifySignature(Buffer.from(BODY), HEADER, SECRET, T + 299).ok, true);
});

test('header malformado é rejeitado', () => {
  assert.equal(verifySignature(Buffer.from(BODY), 'lixo', SECRET, T).ok, false);
  assert.equal(verifySignature(Buffer.from(BODY), '', SECRET, T).ok, false);
});

test('assina um corpo novo e verifica (round-trip)', () => {
  const body = JSON.stringify({ id: 'evt_x', type: 'order.paid', data: { object: { id: 'ord_x', status: 'paid' } } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  assert.equal(verifySignature(Buffer.from(body, 'utf8'), `t=${t},v1=${v1}`, SECRET).ok, true);
});

test('normalização de telemóvel PT', () => {
  assert.equal(normalizePhone('912345678'), '+351912345678');
  assert.equal(normalizePhone('912 345 678'), '+351912345678');
  assert.equal(normalizePhone('+351 962345678'), '+351962345678');
  assert.equal(normalizePhone('351932345678'), '+351932345678');
  assert.equal(normalizePhone('+351912345678'), '+351912345678');
  // 2o digito tem de ser 1/2/3/6
  assert.equal(normalizePhone('942345678'), null);
  assert.equal(normalizePhone('212345678'), null); // fixo
  assert.equal(normalizePhone('91234567'), null);  // curto
  assert.equal(normalizePhone(''), null);
});
