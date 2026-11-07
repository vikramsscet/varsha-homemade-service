'use strict';

const db = require('../../config/database');

const exec = (client) => client || db;
const first = (result) => result.rows[0] || null;

const COLUMNS = 'id, gateway_event_id, event_type, processing_status, attempts, payment_id';

// Idempotent insert keyed on Razorpay's event id; null when this event was already stored.
const insert = async (e) =>
  first(
    await db.query(
      `INSERT INTO payment_webhook_events
         (gateway, gateway_event_id, event_type, razorpay_order_id, razorpay_payment_id,
          razorpay_refund_id, signature_verified, payload)
       VALUES ('RAZORPAY', $1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (gateway, gateway_event_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [e.eventId, e.eventType, e.razorpayOrderId, e.razorpayPaymentId, e.razorpayRefundId, JSON.stringify(e.payload)]
    )
  );

const findByEventId = async (eventId) =>
  first(
    await db.query(`SELECT ${COLUMNS} FROM payment_webhook_events WHERE gateway = 'RAZORPAY' AND gateway_event_id = $1`, [eventId])
  );

// Atomic lease: only one delivery processes an event at a time. A PROCESSING lease older than
// 2 minutes (crashed worker) can be taken over by the next retry.
const claim = async (id) =>
  first(
    await db.query(
      `UPDATE payment_webhook_events
          SET processing_status = 'PROCESSING', attempts = attempts + 1,
              processing_started_at = NOW(), last_error = NULL
        WHERE id = $1
          AND (processing_status IN ('RECEIVED', 'FAILED')
               OR (processing_status = 'PROCESSING' AND processing_started_at < NOW() - INTERVAL '2 minutes'))
        RETURNING ${COLUMNS}`,
      [id]
    )
  );

// Runs inside the business transaction so the "processed" marker commits atomically with the state change.
const finish = async (id, status, reason, paymentId, client) =>
  exec(client).query(
    `UPDATE payment_webhook_events
        SET processing_status = $2, last_error = $3, payment_id = COALESCE($4, payment_id), processed_at = NOW()
      WHERE id = $1`,
    [id, status, reason || null, paymentId || null]
  );

const fail = async (id, message) =>
  db.query(
    `UPDATE payment_webhook_events SET processing_status = 'FAILED', last_error = $2 WHERE id = $1`,
    [id, String(message).slice(0, 500)]
  );

module.exports = { insert, findByEventId, claim, finish, fail };
