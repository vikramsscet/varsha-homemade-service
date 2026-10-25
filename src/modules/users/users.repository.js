'use strict';

const db = require('../../config/database');

const COLUMNS = `id, google_id, email, first_name, last_name, display_name,
  profile_image_url, email_verified, status, last_login_at, created_at, updated_at`;

const first = (result) => result.rows[0] || null;

const findById = async (id) =>
  first(await db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]));

const findByGoogleId = async (googleId) =>
  first(await db.query(`SELECT ${COLUMNS} FROM users WHERE google_id = $1`, [googleId]));

const findByEmail = async (email) =>
  first(await db.query(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]));

// Returns null if a concurrent request already created the row.
const createFromGoogle = async (p) =>
  first(
    await db.query(
      `INSERT INTO users
         (google_id, email, first_name, last_name, display_name,
          profile_image_url, email_verified, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [p.googleId, p.email, p.firstName, p.lastName, p.displayName, p.profileImageUrl, p.emailVerified]
    )
  );

// Sets last_login_at, links google_id (for rows matched by email) and refreshes profile data.
const recordLogin = async (id, p) =>
  first(
    await db.query(
      `UPDATE users SET
         google_id = $2,
         first_name = COALESCE($3, first_name),
         last_name = COALESCE($4, last_name),
         display_name = COALESCE($5, display_name),
         profile_image_url = COALESCE($6, profile_image_url),
         email_verified = email_verified OR $7,
         last_login_at = NOW()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, p.googleId, p.firstName, p.lastName, p.displayName, p.profileImageUrl, p.emailVerified]
    )
  );

module.exports = { findById, findByGoogleId, findByEmail, createFromGoogle, recordLogin };
