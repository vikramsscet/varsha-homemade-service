'use strict';

const db = require('../../config/database');

const exec = (client) => client || db;
const first = (result) => result.rows[0] || null;

const ORDER_COLUMNS = `id, order_number, customer_type, user_id, guest_session_id, guest_access_token_hash,
  cart_id, checkout_idempotency_key, status, currency, subtotal, discount_amount, tax_amount,
  shipping_amount, total_amount, customer_email, customer_phone, shipping_first_name,
  shipping_last_name, shipping_phone, shipping_country, shipping_address_line1,
  shipping_address_line2, shipping_city, shipping_state, shipping_postal_code, confirmed_at,
  paid_at, cancelled_at, payment_expires_at, created_at, updated_at`;
const ITEM_COLUMNS = 'id, order_id, product_id, product_name, product_slug, unit_price, quantity, total_price';
const CART_COLUMNS = 'id, user_id, anonymous_id, status, currency, expires_at';

const lock = (flag) => (flag ? ' FOR UPDATE' : '');

// ---- carts (read/lock only; cart behaviour stays in the cart module) --------------------------
const findCart = async (cartId, { forUpdate = false } = {}, client) =>
  first(await exec(client).query(`SELECT ${CART_COLUMNS} FROM carts WHERE id = $1${lock(forUpdate)}`, [cartId]));

const findActiveUserCart = async (userId, client) =>
  first(
    await exec(client).query(`SELECT ${CART_COLUMNS} FROM carts WHERE user_id = $1 AND status = 'ACTIVE'`, [userId])
  );

const listCartItems = async (cartId, client) =>
  (
    await exec(client).query(
      `SELECT product_id, product_name, product_slug, quantity FROM cart_items
        WHERE cart_id = $1 ORDER BY product_id`,
      [cartId]
    )
  ).rows;

// ---- orders --------------------------------------------------------------------------------
const insertOrder = async (o, client) =>
  first(
    await exec(client).query(
      `INSERT INTO orders
         (customer_type, user_id, guest_session_id, guest_access_token_hash, cart_id,
          checkout_idempotency_key, status, currency, subtotal, discount_amount, tax_amount,
          shipping_amount, total_amount, customer_email, customer_phone,
          shipping_first_name, shipping_last_name, shipping_phone, shipping_country,
          shipping_address_line1, shipping_address_line2, shipping_city, shipping_state,
          shipping_postal_code, payment_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING_PAYMENT','INR',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,$22,$23)
       RETURNING ${ORDER_COLUMNS}`,
      [
        o.customerType, o.userId, o.guestSessionId, o.guestAccessTokenHash, o.cartId,
        o.idempotencyKey, o.totals.subtotal, o.totals.discountAmount, o.totals.taxAmount,
        o.totals.shippingAmount, o.totals.totalAmount, o.customer.email, o.customer.phone,
        o.shipping.firstName, o.shipping.lastName, o.shipping.phone, o.shipping.country,
        o.shipping.addressLine1, o.shipping.addressLine2, o.shipping.city, o.shipping.state,
        o.shipping.postalCode, o.paymentExpiresAt,
      ]
    )
  );

const insertItem = async (orderId, i, client) =>
  first(
    await exec(client).query(
      `INSERT INTO order_items
         (order_id, product_id, product_name, product_slug, unit_price, quantity, total_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${ITEM_COLUMNS}`,
      [orderId, i.productId, i.productName, i.productSlug, i.unitPrice, i.quantity, i.totalPrice]
    )
  );

const listItems = async (orderId, client) =>
  (
    await exec(client).query(`SELECT ${ITEM_COLUMNS} FROM order_items WHERE order_id = $1 ORDER BY product_id`, [
      orderId,
    ])
  ).rows;

const findById = async (orderId, { forUpdate = false } = {}, client) =>
  first(await exec(client).query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1${lock(forUpdate)}`, [orderId]));

const findByIdempotencyKey = async (key, client) =>
  first(await exec(client).query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE checkout_idempotency_key = $1`, [key]));

const OPEN = "('PENDING_PAYMENT', 'PAYMENT_FAILED')";
const SETTLED = "('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')";

const findOpenByCart = async (cartId, { forUpdate = false } = {}, client) =>
  first(
    await exec(client).query(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE cart_id = $1 AND status IN ${OPEN}${lock(forUpdate)}`,
      [cartId]
    )
  );

const hasSettledOrderForCart = async (cartId, client) =>
  (await exec(client).query(`SELECT 1 FROM orders WHERE cart_id = $1 AND status IN ${SETTLED} LIMIT 1`, [cartId]))
    .rowCount > 0;

const closeOrder = async (orderId, status, client) =>
  first(
    await exec(client).query(
      `UPDATE orders SET status = $2, cancelled_at = NOW() WHERE id = $1 AND status IN ${OPEN}
       RETURNING ${ORDER_COLUMNS}`,
      [orderId, status]
    )
  );

// Confirmation happens exactly once: only an unconfirmed, still-payable order can become PAID.
const markPaid = async (orderId, client) =>
  first(
    await exec(client).query(
      `UPDATE orders SET status = 'PAID', paid_at = NOW(), confirmed_at = NOW()
        WHERE id = $1 AND confirmed_at IS NULL AND status IN ${OPEN} RETURNING ${ORDER_COLUMNS}`,
      [orderId]
    )
  );

const markPaymentFailed = async (orderId, client) =>
  first(
    await exec(client).query(
      `UPDATE orders SET status = 'PAYMENT_FAILED' WHERE id = $1 AND status = 'PENDING_PAYMENT'
       RETURNING ${ORDER_COLUMNS}`,
      [orderId]
    )
  );

module.exports = {
  markPaid, markPaymentFailed,
  findCart, findActiveUserCart, listCartItems, insertOrder, insertItem, listItems, findById,
  findByIdempotencyKey, findOpenByCart, hasSettledOrderForCart, closeOrder,
};
