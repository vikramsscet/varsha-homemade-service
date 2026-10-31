'use strict';

// Regression + cleanup tests against the real database. Only run with RUN_DB_TESTS=1
// (writes to DATABASE_URL; migrations 003 and 004 applied). Google login needs a real Google
// credential and is not exercised here; JWT auth is exercised through the cart and address APIs.
process.env.NODE_ENV = 'test';
process.env.PRODUCT_SERVICE_PROVIDER = 'mock';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };
const PRODUCT = '11111111-1111-4111-8111-111111111111';

test('regression: carts, merge, JWT, cleanup', opts, async (t) => {
  const app = require('../src/app');
  const db = require('../src/config/database');
  const { signToken, verifyToken } = require('../src/utils/jwt');
  const guestService = require('../src/modules/guestCheckout/guestCheckout.service');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, anon, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(anon ? { 'X-Anonymous-Cart-ID': anon } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  const counts = async () => (await db.query(
    `SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM carts)::int AS carts,
            (SELECT COUNT(*) FROM cart_items)::int AS items`)).rows[0];
  const before = await counts();

  const email = `regress-${Date.now()}@example.invalid`;
  const user = (await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id, email`, [email])).rows[0];
  const token = signToken(user);
  const createdCarts = [];

  t.after(async () => {
    server.close();
    await db.query('DELETE FROM carts WHERE user_id = $1 OR id = ANY($2)', [user.id, createdCarts]);
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    await db.close();
  });

  await t.test('JWT round-trips and gates /auth/me', async () => {
    assert.equal(verifyToken(token).sub, user.id);
    assert.equal((await call('GET', '/auth/me')).status, 401);
    assert.equal((await call('GET', '/auth/me', { token })).status, 200);
  });

  let anon;
  let anonCart;
  await t.test('anonymous cart create, add item, read', async () => {
    const created = await call('POST', '/carts');
    assert.equal(created.status, 201);
    anon = created.json.data.anonymousId;
    anonCart = created.json.data.id;
    createdCarts.push(anonCart);
    const add = await call('POST', `/carts/${anonCart}/items`, { anon, body: { productId: PRODUCT, quantity: 2 } });
    assert.ok([200, 201].includes(add.status), JSON.stringify(add.json));
    const got = await call('GET', `/carts/${anonCart}`, { anon });
    assert.equal(got.json.data.itemCount, 2);
    assert.equal((await call('GET', `/carts/${anonCart}`, { anon: crypto.randomUUID() })).status, 404);
  });

  await t.test('guest session creation does not alter the anonymous cart', async () => {
    const s = await call('POST', '/guest-checkout/sessions', { body: { anonymousCartId: anon } });
    assert.equal(s.status, 201);
    const got = await call('GET', `/carts/${anonCart}`, { anon });
    assert.equal(got.json.data.itemCount, 2);
    assert.equal(got.json.data.status, 'ACTIVE');
  });

  await t.test('anonymous cart merges into the authenticated cart', async () => {
    const merged = await call('POST', `/carts/${anonCart}/merge`, { token, anon });
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    assert.equal(merged.json.data.ownerType, 'USER');
    assert.equal(merged.json.data.itemCount, 2);
    createdCarts.push(merged.json.data.id);
    const current = await call('GET', '/carts/current', { token });
    assert.equal(current.json.data.itemCount, 2);
  });

  await t.test('cleanup deletes only long-expired sessions and never carts', async () => {
    const mk = async (interval) => (await db.query(
      `INSERT INTO guest_checkout_sessions (session_token_hash, anonymous_cart_id, expires_at)
       VALUES ($1, $2, NOW() + $3::interval) RETURNING id`,
      [guestService.hashToken(crypto.randomBytes(32).toString('base64url')), anonCart, interval])).rows[0].id;
    const longExpired = await mk('-3 days');
    const recentlyExpired = await mk('-1 hour');
    const active = await mk('1 hour');

    const deleted = await guestService.cleanupExpired();
    assert.ok(deleted >= 1);
    const left = (await db.query('SELECT id FROM guest_checkout_sessions WHERE id = ANY($1)',
      [[longExpired, recentlyExpired, active]])).rows.map((r) => r.id);
    assert.deepEqual(left.sort(), [recentlyExpired, active].sort());
    assert.equal((await db.query('SELECT 1 FROM carts WHERE id = $1', [anonCart])).rows.length, 1);
    await db.query('DELETE FROM guest_checkout_sessions WHERE id = ANY($1)', [[recentlyExpired, active]]);
  });

  await t.test('existing records are intact after the suite', async () => {
    await db.query('DELETE FROM guest_checkout_sessions WHERE anonymous_cart_id = ANY($1)', [createdCarts]);
    await db.query('DELETE FROM carts WHERE user_id = $1 OR id = ANY($2)', [user.id, createdCarts]);
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    assert.deepEqual(await counts(), before);
  });
});
