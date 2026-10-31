'use strict';

const db = require('../../config/database');

const exec = (client) => client || db;
const first = (result) => result.rows[0] || null;

// session_token_hash is deliberately not selected by anything except the hash lookup condition.
const COLUMNS = `id, anonymous_cart_id, email, first_name, last_name, phone, country, address_line1,
  address_line2, city, state, postal_code, expires_at, created_at, updated_at`;

// Read-only lookup of the caller's ACTIVE anonymous cart (does not touch cart behaviour).
const findActiveCartIdByAnonymousId = async (anonymousId, client) =>
  first(
    await exec(client).query(
      `SELECT id FROM carts WHERE anonymous_id = $1 AND status = 'ACTIVE'`,
      [anonymousId]
    )
  );

const insert = async (tokenHash, cartId, expiresAt, client) =>
  first(
    await exec(client).query(
      `INSERT INTO guest_checkout_sessions (session_token_hash, anonymous_cart_id, expires_at)
       VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [tokenHash, cartId, expiresAt]
    )
  );

// Returns the row even if expired (the caller distinguishes expired from unknown).
const findByTokenHash = async (tokenHash, client) =>
  first(
    await exec(client).query(
      `SELECT ${COLUMNS} FROM guest_checkout_sessions WHERE session_token_hash = $1`,
      [tokenHash]
    )
  );

// `columns` maps column name -> value; names come from a fixed whitelist in the service.
const updateDetails = async (id, columns, client) => {
  const names = Object.keys(columns);
  const sets = names.map((n, i) => `${n} = $${i + 2}`).join(', ');
  return first(
    await exec(client).query(
      `UPDATE guest_checkout_sessions SET ${sets}
        WHERE id = $1 AND expires_at > NOW() RETURNING ${COLUMNS}`,
      [id, ...names.map((n) => columns[n])]
    )
  );
};

const remove = async (id, client) =>
  (await exec(client).query('DELETE FROM guest_checkout_sessions WHERE id = $1', [id])).rowCount;

// Deletes only sessions whose expiry is more than `graceSeconds` in the past. The grace period
// keeps "expired" distinguishable from "not found" for recently expired tokens. Carts are never touched.
const deleteExpired = async (graceSeconds, client) =>
  (
    await exec(client).query(
      `DELETE FROM guest_checkout_sessions WHERE expires_at < NOW() - make_interval(secs => $1)`,
      [graceSeconds]
    )
  ).rowCount;

module.exports = {
  findActiveCartIdByAnonymousId, insert, findByTokenHash, updateDetails, remove, deleteExpired,
};
