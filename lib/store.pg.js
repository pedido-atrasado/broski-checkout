// Postgres. API publica IDENTICA a ./store.js — migrar e trocar a linha de
// import no server.js:
//   import * as store from './lib/store.pg.js';
//
// Requer:  npm i pg   e   DATABASE_URL no .env
//
// Toda a concorrencia esta resolvida em SQL, num unico statement por operacao:
// nada de SELECT-depois-UPDATE, que perde a corrida entre dois webhooks.
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

const SCHEMA = `
create table if not exists orders (
  external_reference text primary key,
  broski_id          text unique,
  amount             integer not null,
  amount_refunded    integer not null default 0,
  method             text not null,
  status             text not null,
  customer           jsonb,
  description        text,
  comment            text,
  multibanco         jsonb,
  fulfilled          boolean not null default false,
  fulfilled_at       timestamptz,
  paid_at            timestamptz,
  fallback_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists webhook_events (
  id          text primary key,
  received_at timestamptz not null default now()
);
`;

export async function init() {
  await pool.query(SCHEMA);
}

// Ordem dos estados: um webhook atrasado nao pode fazer `paid` voltar a `pending`.
const RANK = { created: 0, pending: 1, awaiting_payment: 1, expired: 2, failed: 2, paid: 3, refunded: 4 };
const rank = (s) => (s in RANK ? RANK[s] : 0);

// Mesma tabela de ordem, do lado do SQL, aplicada ao estado ATUAL da linha.
const RANK_SQL = `(case o.status
  when 'created'  then 0
  when 'pending'  then 1
  when 'awaiting_payment' then 1
  when 'expired'  then 2
  when 'failed'   then 2
  when 'paid'     then 3
  when 'refunded' then 4
  else 0 end)`;

export async function createLocalOrder({ externalReference, amount, method, customer, description, comment = null }) {
  const { rows } = await pool.query(
    `insert into orders (external_reference, amount, method, status, customer, description, comment)
     values ($1, $2, $3, 'created', $4, $5, $6)
     returning *`,
    [externalReference, amount, method, customer, description, comment],
  );
  return rows[0];
}

export async function attachBroskiOrder(externalReference, order) {
  const { rows } = await pool.query(
    `update orders o
        set broski_id  = $2,
            status     = case when $4 >= ${RANK_SQL} then $3 else o.status end,
            multibanco = coalesce($5::jsonb, o.multibanco),
            updated_at = now()
      where o.external_reference = $1
      returning o.*`,
    [externalReference, order.id, order.status, rank(order.status), order.multibanco ?? null],
  );
  return rows[0] || null;
}

export async function getByRef(ref) {
  const { rows } = await pool.query('select * from orders where external_reference = $1', [ref]);
  return rows[0] || null;
}

export async function getByBroskiId(id) {
  const { rows } = await pool.query('select * from orders where broski_id = $1', [id]);
  return rows[0] || null;
}

/**
 * Aplica o objeto `order` do webhook (ou de um GET de fallback).
 * greatest() no amount_refunded: os eventos chegam sem ordem, um estorno
 * antigo nao pode reduzir o total ja registado.
 */
export async function applyOrderObject(obj) {
  const { rows } = await pool.query(
    `update orders o
        set status          = case when $3 >= ${RANK_SQL} then $2 else o.status end,
            amount_refunded = greatest(o.amount_refunded, coalesce($4::int, o.amount_refunded)),
            multibanco      = coalesce($5::jsonb, o.multibanco),
            paid_at         = coalesce(o.paid_at, $6::timestamptz),
            updated_at      = now()
      where o.broski_id = $1
      returning o.*`,
    [
      obj.id,
      obj.status,
      rank(obj.status),
      typeof obj.amount_refunded === 'number' ? obj.amount_refunded : null,
      obj.multibanco ?? null,
      obj.paid_at ?? null,
    ],
  );
  return rows[0] || null;
}

/**
 * Dedupe. A PK faz o trabalho todo: um unico statement, sem SELECT antes.
 * Devolve true se o evento JA tinha sido visto (o insert nao devolveu linha).
 */
export async function seenEvent(eventId) {
  const { rowCount } = await pool.query(
    'insert into webhook_events (id) values ($1) on conflict (id) do nothing returning id',
    [eventId],
  );
  return rowCount === 0;
}

/** Liberta o evento se o processamento falhou, para o retry de 24h poder repetir. */
export async function forgetEvent(eventId) {
  const { rowCount } = await pool.query('delete from webhook_events where id = $1', [eventId]);
  return rowCount === 1;
}

/** True SO na primeira chamada — o WHERE ... IS NULL resolve a corrida. */
export async function claimFallback(externalReference) {
  const { rowCount } = await pool.query(
    `update orders set fallback_at = now()
      where external_reference = $1 and fallback_at is null
      returning 1`,
    [externalReference],
  );
  return rowCount === 1;
}

/** Entrega exatamente uma vez: o WHERE fulfilled = false resolve a corrida. */
export async function markFulfilled(rec) {
  const { rowCount } = await pool.query(
    `update orders set fulfilled = true, fulfilled_at = now(), updated_at = now()
      where external_reference = $1 and fulfilled = false
      returning 1`,
    [rec.external_reference],
  );
  return rowCount === 1;
}

/** Conciliação: nunca só pelo status — estorno parcial mantém "paid". Puro, fica sincrono. */
export const netAmount = (rec) => rec.amount - (rec.amount_refunded || 0);
