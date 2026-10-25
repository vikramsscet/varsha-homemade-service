'use strict';

const db = require('../../config/database');

// Every function takes an optional pg client so callers can run inside a transaction.
const exec = (client) => client || db;
const first = (result) => result.rows[0] || null;

const CART_COLUMNS = `id, user_id, anonymous_id, status, currency, subtotal, discount_amount,
  tax_amount, total_amount, expires_at, created_at, updated_at`;
const ITEM_COLUMNS = `id, cart_id, product_id, product_name, product_slug, unit_price, quantity,
  total_price, created_at, updated_at`;

// Owner filter: ($n = user id) or anonymous id, depending on the owner type.
const ownerClause = (owner, idx) =>
  owner.userId ? [`user_id = $${idx}`, owner.userId] : [`anonymous_id = $${idx}`, owner.anonymousId];

const markStaleExpired = async (owner, client) => {
  const [clause, value] = ownerClause(owner, 1);
  await exec(client).query(
    `UPDATE carts SET status = 'EXPIRED'
      WHERE ${clause} AND status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= NOW()`,
    [value]
  );
};

// Returns null when an ACTIVE cart already exists for the owner (unique partial index).
const insertCart = async (owner, expiresAt, client) =>
  first(
    await exec(client).query(
      `INSERT INTO carts (user_id, anonymous_id, status, expires_at)
       VALUES ($1, $2, 'ACTIVE', $3)
       ON CONFLICT DO NOTHING
       RETURNING ${CART_COLUMNS}`,
      [owner.userId || null, owner.anonymousId || null, expiresAt]
    )
  );

const findActiveByOwner = async (owner, { lock = false } = {}, client) => {
  const [clause, value] = ownerClause(owner, 1);
  return first(
    await exec(client).query(
      `SELECT ${CART_COLUMNS} FROM carts WHERE ${clause} AND status = 'ACTIVE'${lock ? ' FOR UPDATE' : ''}`,
      [value]
    )
  );
};

// Ownership is part of the query: another owner's cart is simply "not found".
const findOwnedById = async (cartId, owner, { lock = false } = {}, client) => {
  const [clause, value] = ownerClause(owner, 2);
  return first(
    await exec(client).query(
      `SELECT ${CART_COLUMNS} FROM carts WHERE id = $1 AND ${clause}${lock ? ' FOR UPDATE' : ''}`,
      [cartId, value]
    )
  );
};

const listItems = async (cartId, client) =>
  (
    await exec(client).query(
      `SELECT ${ITEM_COLUMNS} FROM cart_items WHERE cart_id = $1 ORDER BY created_at, id`,
      [cartId]
    )
  ).rows;

const findItem = async (cartId, itemId, client) =>
  first(
    await exec(client).query(
      `SELECT ${ITEM_COLUMNS} FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [itemId, cartId]
    )
  );

const findItemByProduct = async (cartId, productId, client) =>
  first(
    await exec(client).query(
      `SELECT ${ITEM_COLUMNS} FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cartId, productId]
    )
  );

const countItems = async (cartId, client) =>
  (await exec(client).query('SELECT COUNT(*)::int AS n FROM cart_items WHERE cart_id = $1', [cartId]))
    .rows[0].n;

const insertItem = async (cartId, p, client) =>
  first(
    await exec(client).query(
      `INSERT INTO cart_items
         (cart_id, product_id, product_name, product_slug, unit_price, quantity, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${ITEM_COLUMNS}`,
      [cartId, p.productId, p.productName, p.productSlug, p.unitPrice, p.quantity, p.totalPrice]
    )
  );

const updateItem = async (itemId, p, client) =>
  first(
    await exec(client).query(
      `UPDATE cart_items SET
         product_name = $2, product_slug = $3, unit_price = $4, quantity = $5, total_price = $6
       WHERE id = $1
       RETURNING ${ITEM_COLUMNS}`,
      [itemId, p.productName, p.productSlug, p.unitPrice, p.quantity, p.totalPrice]
    )
  );

const deleteItem = async (cartId, itemId, client) =>
  (await exec(client).query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cartId]))
    .rowCount;

const deleteAllItems = async (cartId, client) =>
  exec(client).query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);

const updateTotals = async (cartId, t, client) =>
  first(
    await exec(client).query(
      `UPDATE carts SET subtotal = $2, discount_amount = $3, tax_amount = $4, total_amount = $5
       WHERE id = $1 RETURNING ${CART_COLUMNS}`,
      [cartId, t.subtotal, t.discountAmount, t.taxAmount, t.totalAmount]
    )
  );

const setStatus = async (cartId, status, client) =>
  first(
    await exec(client).query(`UPDATE carts SET status = $2 WHERE id = $1 RETURNING ${CART_COLUMNS}`, [
      cartId,
      status,
    ])
  );

const deleteCart = async (cartId, client) =>
  exec(client).query('DELETE FROM carts WHERE id = $1', [cartId]);

module.exports = {
  markStaleExpired,
  insertCart,
  findActiveByOwner,
  findOwnedById,
  listItems,
  findItem,
  findItemByProduct,
  countItems,
  insertItem,
  updateItem,
  deleteItem,
  deleteAllItems,
  updateTotals,
  setStatus,
  deleteCart,
};
