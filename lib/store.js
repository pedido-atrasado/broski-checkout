// Persistencia em ficheiro JSON. Contrato 100% async — igual ao de ./store.pg.js,
// para que migrar seja trocar UMA linha de import no server.js.
//
// O que importa e o contrato: o estado do pedido vem do WEBHOOK, nunca do browser.
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'data', 'orders.json');

let db = { orders: {}, byRef: {}, events: {} };
let carregado = false;

// ---------------------------------------------------------------------------
// Escrita serializada + atomica.
// Serializada: cada save() encadeia no anterior, por isso dois webhooks a chegar
//   ao mesmo tempo nao gravam por cima um do outro.
// Atomica: escreve para .tmp e faz rename — se o processo morrer a meio, o
//   orders.json fica intacto em vez de truncado.
// ---------------------------------------------------------------------------
let fila = Promise.resolve();

function save() {
  fila = fila.then(async () => {
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, FILE);          // atomico no mesmo filesystem
  }).catch((err) => {
    console.error('[store] falha ao gravar', err);
  });
  return fila;
}

/** Carrega data/orders.json; cria a pasta se nao existir. */
export async function init() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  try {
    const bruto = await fs.readFile(FILE, 'utf8');
    db = JSON.parse(bruto);
    db.orders ||= {}; db.byRef ||= {}; db.events ||= {};
  } catch {
    db = { orders: {}, byRef: {}, events: {} };   // primeira execucao
  }
  carregado = true;
  return db;
}

async function pronto() { if (!carregado) await init(); }

// ---------------------------------------------------------------------------
// Ordem dos estados. Os webhooks chegam SEM ordem garantida, por isso um evento
// atrasado nao pode fazer um pedido `paid` voltar a `pending`.
// ---------------------------------------------------------------------------
const RANK = { created: 0, pending: 1, awaiting_payment: 1, expired: 2, failed: 2, paid: 3, refunded: 4 };
const rank = (s) => (s in RANK ? RANK[s] : 0);

export async function createLocalOrder({ externalReference, amount, method, customer, description, comment = null }) {
  await pronto();
  const agora = new Date().toISOString();
  const rec = {
    external_reference: externalReference,
    broski_id: null,
    amount,
    amount_refunded: 0,
    method,
    status: 'created',
    customer,
    description,
    comment,
    multibanco: null,
    fulfilled: false,
    fulfilled_at: null,
    paid_at: null,
    fallback_at: null,
    created_at: agora,
    updated_at: agora,
  };
  db.byRef[externalReference] = rec;
  await save();
  return rec;
}

export async function attachBroskiOrder(externalReference, order) {
  await pronto();
  const rec = db.byRef[externalReference];
  if (!rec) return null;
  rec.broski_id = order.id;
  if (rank(order.status) >= rank(rec.status)) rec.status = order.status;
  if (order.multibanco) rec.multibanco = order.multibanco;
  rec.updated_at = new Date().toISOString();
  db.orders[order.id] = externalReference;
  await save();
  return rec;
}

export async function getByRef(ref) {
  await pronto();
  return db.byRef[ref] || null;
}

export async function getByBroskiId(id) {
  await pronto();
  return db.orders[id] ? (db.byRef[db.orders[id]] || null) : null;
}

/** Aplica o objeto `order` vindo do webhook (ou de um GET de fallback). */
export async function applyOrderObject(obj) {
  await pronto();
  const rec = await getByBroskiId(obj.id);
  if (!rec) return null;

  if (rank(obj.status) >= rank(rec.status)) rec.status = obj.status;      // nunca regride
  if (typeof obj.amount_refunded === 'number') {
    rec.amount_refunded = Math.max(rec.amount_refunded || 0, obj.amount_refunded);  // nunca diminui
  }
  if (obj.multibanco) rec.multibanco = obj.multibanco;
  if (obj.paid_at && !rec.paid_at) rec.paid_at = obj.paid_at;
  rec.updated_at = new Date().toISOString();
  await save();
  return rec;
}

/**
 * Dedupe de eventos: a entrega e at-least-once e SEM ordem garantida.
 * Devolve true se o evento JA tinha sido visto.
 * A marca fica em memoria antes do await, por isso duas chamadas em paralelo
 * para o mesmo id nunca devolvem ambas false.
 */
export async function seenEvent(eventId) {
  await pronto();
  if (db.events[eventId]) return true;
  db.events[eventId] = Date.now();
  await save();
  return false;
}

/** Liberta o evento se o processamento falhou, para o retry de 24h poder repetir. */
export async function forgetEvent(eventId) {
  await pronto();
  if (!(eventId in db.events)) return false;
  delete db.events[eventId];
  await save();
  return true;
}

/**
 * Marca que o GET de fallback ja foi feito. True SO na primeira chamada.
 * Sem isto, cada poll do browser (2,5s) dispararia um GET a API Broski.
 */
export async function claimFallback(externalReference) {
  await pronto();
  const rec = db.byRef[externalReference];
  if (!rec || rec.fallback_at) return false;
  rec.fallback_at = new Date().toISOString();   // antes do await: ganha a corrida
  await save();
  return true;
}

/** Entrega exatamente uma vez: true so na primeira chamada. */
export async function markFulfilled(rec) {
  await pronto();
  const row = db.byRef[rec.external_reference];
  if (!row || row.fulfilled) return false;
  row.fulfilled = true;                          // antes do await
  row.fulfilled_at = new Date().toISOString();
  row.updated_at = row.fulfilled_at;
  await save();
  return true;
}

/** Conciliação: nunca só pelo status — estorno parcial mantém "paid". Puro, fica sincrono. */
export const netAmount = (rec) => rec.amount - (rec.amount_refunded || 0);
