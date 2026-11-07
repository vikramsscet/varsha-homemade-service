'use strict';

// Read-only queries for a customer's order history. Every query is scoped to user_id AND
// customer_type = 'USER', so guest orders and other customers' orders can never be returned.

const db = require('../../config/database');

// Microsecond-exact timestamp for the cursor (a JS Date would truncate to milliseconds and break keyset paging).
const CURSOR_TS = `to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One page of orders, newest first, each with its order-level payment (the successful payment if any,
 * otherwise the latest attempt) fetched by a single LATERAL join: no per-order queries.
 * Fetches limit + 1 rows so the caller can tell whether another page exists.
 */
const listPage = async (userId, { status, after, limit }) => {
  const params = [userId];
  const where = ['o.user_id = $1', "o.customer_type = 'USER'"];
  if (status) {
    params.push(status);
    where.push(`o.status = $${params.length}`);
  }
  if (after) {
    params.push(after.createdAt, after.id);
    where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, o.currency, o.subtotal, o.discount_amount, o.tax_amount,
            o.shipping_amount, o.total_amount, o.created_at, ${CURSOR_TS} AS cursor_ts,
            p.id AS payment_id, p.status AS payment_status, p.method AS payment_method,
            p.card_network, p.card_last4, p.card_type, p.card_issuer, p.bank_code, p.wallet_name,
            p.upi_handle_masked
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT id, status, method, card_network, card_last4, card_type, card_issuer, bank_code,
                wallet_name, upi_handle_masked
           FROM payments
          WHERE order_id = o.id
          ORDER BY (status IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED')) DESC, attempt_number DESC
          LIMIT 1
       ) p ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
};

const findOwnedOrder = async (userId, orderId) =>
  (
    await db.query(
      `SELECT id, order_number, status, currency, subtotal, discount_amount, tax_amount, shipping_amount,
              total_amount, shipping_first_name, shipping_last_name, shipping_phone, shipping_country,
              shipping_address_line1, shipping_address_line2, shipping_city, shipping_state,
              shipping_postal_code, paid_at, created_at
         FROM orders WHERE id = $1 AND user_id = $2 AND customer_type = 'USER'`,
      [orderId, userId]
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
      `SELECT id, razorpay_payment_id, status, method, amount, currency, card_network, card_last4,
              card_type, card_issuer, bank_code, wallet_name, upi_handle_masked, created_at, captured_at
         FROM payments WHERE order_id = $1 ORDER BY attempt_number DESC`,
      [orderId]
    )
  ).rows;

module.exports = { listPage, findOwnedOrder, listItems, listPayments };
