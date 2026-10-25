'use strict';

const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.database.url,
  ssl: env.database.ssl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Always pass user input via `params` (parameterized queries).
const query = (text, params) => pool.query(text, params);

// For future multi-statement work (e.g. checkout): const client = await getClient()
const getClient = () => pool.connect();

// Runs fn(client) inside BEGIN/COMMIT; rolls back and rethrows on any error.
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const close = () => pool.end();

module.exports = { pool, query, getClient, withTransaction, close };
