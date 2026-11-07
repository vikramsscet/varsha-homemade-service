'use strict';

const db = require('../../config/database');

const exec = (client) => client || db;
const first = (result) => result.rows[0] || null;

const COLUMNS = `id, order_id, attempt_number, gateway, razorpay_order_id, razorpay_payment_id, status,
  currency, amount, amount_refunded, created_at, updated_at`;

const findOpenByOrder = async (orderId, client) =>
  first(
    await exec(client).query(
      `SELECT ${COLUMNS} FROM payments WHERE order_id = $1 AND status IN ('CREATED','PENDING','AUTHORIZED')`,
      [orderId]
    )
  );

const hasSuccessfulPayment = async (orderId, client) =>
  (
    await exec(client).query(
      `SELECT 1 FROM payments WHERE order_id = $1 AND status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED') LIMIT 1`,
      [orderId]
    )
  ).rowCount > 0;

const nextAttemptNumber = async (orderId, client) =>
  (
    await exec(client).query('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM payments WHERE order_id = $1', [
      orderId,
    ])
  ).rows[0].n;

const insert = async (p, client) =>
  first(
    await exec(client).query(
      `INSERT INTO payments (id, order_id, attempt_number, razorpay_order_id, status, currency, amount)
       VALUES ($1,$2,$3,$4,'CREATED',$5,$6) RETURNING ${COLUMNS}`,
      [p.id, p.orderId, p.attemptNumber, p.razorpayOrderId, p.currency, p.amount]
    )
  );

// Append-only audit ledger. Replays of the same fact collide on idempotency_key and are ignored.
const insertTransaction = async (t, client) =>
  first(
    await exec(client).query(
      `INSERT INTO payment_transactions
         (payment_id, type, status, amount, currency, idempotency_key, source, error_code,
          gateway_response, webhook_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [t.paymentId, t.type, t.status, t.amount, t.currency, t.idempotencyKey, t.source,
        t.errorCode || null, t.gatewayResponse ? JSON.stringify(t.gatewayResponse) : null,
        t.webhookEventId || null]
    )
  );

// Closes unfinished (CREATED only) attempts of an order that is being superseded/expired.
const closeCreatedAttempts = async (orderId, status, errorCode, client) => {
  const { rows } = await exec(client).query(
    `UPDATE payments SET status = $2, failed_at = NOW() WHERE order_id = $1 AND status = 'CREATED'
     RETURNING id, amount, currency`,
    [orderId, status]
  );
  for (const p of rows) {
    await insertTransaction(
      {
        paymentId: p.id, type: 'FAILURE', status: 'FAILED', amount: p.amount, currency: p.currency,
        idempotencyKey: `close:${p.id}`, source: 'SYSTEM', errorCode,
      },
      client
    );
  }
  return rows.length;
};

const hasInFlightAttempt = async (orderId, client) =>
  (
    await exec(client).query(`SELECT 1 FROM payments WHERE order_id = $1 AND status IN ('PENDING','AUTHORIZED') LIMIT 1`, [
      orderId,
    ])
  ).rowCount > 0;

const DETAIL_COLUMNS = `${COLUMNS}, method, failure_code, failure_reason`;

const findById = async (id, { forUpdate = false } = {}, client) =>
  first(
    await exec(client).query(
      `SELECT ${DETAIL_COLUMNS} FROM payments WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id]
    )
  );

// State transitions are guarded in SQL (status IN ...) so they can never move a settled payment backwards.
const findByRazorpayOrderId = async (razorpayOrderId, client) =>
  first(await exec(client).query(`SELECT ${DETAIL_COLUMNS} FROM payments WHERE razorpay_order_id = $1`, [razorpayOrderId]));

const markPending = async (id, razorpayPaymentId, client) =>
  first(
    await exec(client).query(
      `UPDATE payments SET status = 'PENDING', razorpay_payment_id = $2
        WHERE id = $1 AND status = 'CREATED' RETURNING ${DETAIL_COLUMNS}`,
      [id, razorpayPaymentId]
    )
  );

const markAuthorized = async (id, d, client) =>
  first(
    await exec(client).query(
      `UPDATE payments SET status = 'AUTHORIZED', razorpay_payment_id = $2, method = $3,
              authorized_at = COALESCE(authorized_at, NOW()), failure_code = NULL, failure_reason = NULL
        WHERE id = $1 AND status IN ('CREATED','PENDING','FAILED') RETURNING ${DETAIL_COLUMNS}`,
      [id, d.id, d.method]
    )
  );

const markCaptured = async (id, d, client) =>
  first(
    await exec(client).query(
      `UPDATE payments SET status = 'CAPTURED', razorpay_payment_id = $2, method = $3,
              authorized_at = COALESCE(authorized_at, NOW()), captured_at = NOW(),
              failure_code = NULL, failure_reason = NULL, failed_at = NULL
        WHERE id = $1 AND status IN ('CREATED','PENDING','AUTHORIZED','FAILED') RETURNING ${DETAIL_COLUMNS}`,
      [id, d.id, d.method]
    )
  );

const markFailed = async (id, d, client) =>
  first(
    await exec(client).query(
      `UPDATE payments SET status = 'FAILED', razorpay_payment_id = $2, method = $3,
              failure_code = $4, failure_reason = $5, failed_at = NOW()
        WHERE id = $1 AND status IN ('CREATED','PENDING','AUTHORIZED') RETURNING ${DETAIL_COLUMNS}`,
      [id, d.id, d.method, (d.errorCode || '').slice(0, 100) || null, d.errorDescription || null]
    )
  );

module.exports = {
  findById, findByRazorpayOrderId, markPending, markAuthorized, markCaptured, markFailed,
  findOpenByOrder, hasSuccessfulPayment, nextAttemptNumber, insert, insertTransaction,
  closeCreatedAttempts, hasInFlightAttempt,
};
