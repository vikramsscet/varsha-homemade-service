'use strict';

// Read-only, cross-customer order queries for the Admin CMS. Every value reaches SQL as a bound
// parameter; only fixed fragments are concatenated. Nothing here writes.

const db = require('../../config/database');

// Microsecond-exact timestamp for the keyset cursor (a JS Date would truncate to milliseconds).
const CURSOR_TS = `to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

// The order-level payment: the successful attempt if any, otherwise the latest attempt.
const PAYMENT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT id, status, method, card_network, card_last4, bank_code, wallet_name
      FROM payments
     WHERE order_id = o.id
     ORDER BY (status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')) DESC, attempt_number DESC
     LIMIT 1
  ) p ON TRUE`;

const ORDER_COLUMNS = `
  o.id, o.order_number, o.status, o.currency, o.subtotal, o.discount_amount, o.tax_amount,
  o.shipping_amount, o.total_amount, o.customer_type, o.user_id, o.customer_email, o.customer_phone,
  o.shipping_first_name, o.shipping_last_name, o.created_at, o.paid_at,
  u.first_name AS user_first_name, u.last_name AS user_last_name`;

const listPage = async ({ userId, status, paymentStatus, search, createdFrom, createdBefore, after, limit }) => {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [];

  if (userId) {
    where.push(`o.user_id = ${bind(userId)}`, "o.customer_type = 'USER'");
  }
  if (status) where.push(`o.status = ${bind(status)}`);
  if (paymentStatus) where.push(`p.status = ${bind(paymentStatus)}`);
  if (createdFrom) where.push(`o.created_at >= ${bind(createdFrom)}::timestamptz`);
  if (createdBefore) where.push(`o.created_at < ${bind(createdBefore)}::timestamptz`);
  if (search) {
    const escaped = escapeLike(search);
    const prefix = bind(`${escaped}%`);
    const contains = bind(`%${escaped.toLowerCase()}%`);
    where.push(`(
      o.order_number ILIKE ${prefix} ESCAPE '\\'
      OR lower(o.customer_email) LIKE ${contains} ESCAPE '\\'
      OR o.customer_phone LIKE ${contains} ESCAPE '\\'
      OR lower(concat_ws(' ', coalesce(u.first_name, o.shipping_first_name),
                              coalesce(u.last_name, o.shipping_last_name))) LIKE ${contains} ESCAPE '\\'
    )`);
  }
  if (after) {
    where.push(`(o.created_at, o.id) < (${bind(after.createdAt)}::timestamptz, ${bind(after.id)}::uuid)`);
  }

  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS}, ${CURSOR_TS} AS cursor_ts,
            p.status AS payment_status, p.method AS payment_method, p.card_network, p.card_last4,
            p.bank_code, p.wallet_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${PAYMENT_LATERAL}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${bind(limit + 1)}`,
    params
  );
  return rows;
};

const findOrder = async (orderId) =>
  (
    await db.query(
      `SELECT ${ORDER_COLUMNS}, o.shipping_phone, o.shipping_country, o.shipping_address_line1,
              o.shipping_address_line2, o.shipping_city, o.shipping_state, o.shipping_postal_code,
              o.confirmed_at, o.cancelled_at, o.updated_at
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
        WHERE o.id = $1`,
      [orderId]
    )
  ).rows[0] || null;

const listItems = async (orderId) =>
  (
    await db.query(
      `SELECT product_id, product_name, product_slug, unit_price, quantity, total_price
         FROM order_items WHERE order_id = $1 ORDER BY created_at, product_id`,
      [orderId]
    )
  ).rows;

const listPayments = async (orderId) =>
  (
    await db.query(
      `SELECT id, attempt_number, razorpay_payment_id, status, method, amount, amount_refunded, currency,
              card_network, card_last4, card_type, card_issuer, bank_code, wallet_name, upi_handle_masked,
              failure_code, failure_reason, created_at, authorized_at, captured_at, failed_at
         FROM payments WHERE order_id = $1 ORDER BY attempt_number DESC`,
      [orderId]
    )
  ).rows;

module.exports = { listPage, findOrder, listItems, listPayments, escapeLike };
