'use strict';

const db = require('../../config/database');

// Every function takes an optional pg client so callers can run inside a transaction.
const exec = (client) => client || db;
const first = (result) => result.rows[0] || null;

const COLUMNS = `id, user_id, first_name, last_name, phone, country, address_line1, address_line2,
  city, state, postal_code, is_default, created_at, updated_at`;

// Serialises all address writes for one user. Returns null when the user no longer exists.
const lockUser = async (userId, client) =>
  first(await exec(client).query("SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE", [userId]));

const listByUser = async (userId, client) =>
  (
    await exec(client).query(
      `SELECT ${COLUMNS} FROM user_addresses WHERE user_id = $1
        ORDER BY is_default DESC, updated_at DESC, id`,
      [userId]
    )
  ).rows;

const countByUser = async (userId, client) =>
  (await exec(client).query('SELECT COUNT(*)::int AS n FROM user_addresses WHERE user_id = $1', [userId]))
    .rows[0].n;

// Ownership is part of the query: another user's address is simply "not found".
const findOwned = async (id, userId, client) =>
  first(
    await exec(client).query(`SELECT ${COLUMNS} FROM user_addresses WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ])
  );

const insert = async (userId, a, isDefault, client) =>
  first(
    await exec(client).query(
      `INSERT INTO user_addresses
         (user_id, first_name, last_name, phone, country, address_line1, address_line2,
          city, state, postal_code, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUMNS}`,
      [userId, a.firstName, a.lastName, a.phone, a.country, a.addressLine1, a.addressLine2 || null,
        a.city, a.state, a.postalCode, isDefault]
    )
  );

const update = async (id, userId, a, isDefault, client) =>
  first(
    await exec(client).query(
      `UPDATE user_addresses SET
         first_name = $3, last_name = $4, phone = $5, country = $6, address_line1 = $7,
         address_line2 = $8, city = $9, state = $10, postal_code = $11, is_default = $12
       WHERE id = $1 AND user_id = $2
       RETURNING ${COLUMNS}`,
      [id, userId, a.firstName, a.lastName, a.phone, a.country, a.addressLine1,
        a.addressLine2 || null, a.city, a.state, a.postalCode, isDefault]
    )
  );

const clearDefault = async (userId, client) =>
  exec(client).query('UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1 AND is_default', [
    userId,
  ]);

const setDefault = async (id, userId, client) =>
  first(
    await exec(client).query(
      `UPDATE user_addresses SET is_default = TRUE WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      [id, userId]
    )
  );

const remove = async (id, userId, client) =>
  (await exec(client).query('DELETE FROM user_addresses WHERE id = $1 AND user_id = $2', [id, userId]))
    .rowCount;

// Promotes the most recently updated remaining address. Returns null if none remain.
const promoteLatest = async (userId, client) =>
  first(
    await exec(client).query(
      `UPDATE user_addresses SET is_default = TRUE
        WHERE id = (SELECT id FROM user_addresses WHERE user_id = $1
                     ORDER BY updated_at DESC, id LIMIT 1)
       RETURNING ${COLUMNS}`,
      [userId]
    )
  );

module.exports = {
  lockUser, listByUser, countByUser, findOwned, insert, update, clearDefault, setDefault, remove,
  promoteLatest,
};
