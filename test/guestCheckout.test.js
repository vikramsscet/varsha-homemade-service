'use strict';

// Offline tests always run. Integration tests write to DATABASE_URL (migrations 003 and 004
// applied) and only run with RUN_DB_TESTS=1.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const service = require('../src/modules/guestCheckout/guestCheckout.service');
const { updateSchema, createSchema } = require('../src/modules/guestCheckout/guestCheckout.validation');

const HEADER = 'X-Guest-Checkout-Session';
const enabled = process.env.RUN_DB_TESTS === '1';
const dbOpts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };

const details = {
  customer: { email: 'Customer@Example.com', firstName: 'Vikram', lastName: 'Rao', phone: '+918319510666' },
  deliveryAddress: {
    country: 'India', addressLine1: 'Beverly Hills Society', addressLine2: 'Building A, Flat 101',
    city: 'Pune', state: 'Maharashtra', postalCode: '411057',
  },
};

test('validation: partial and full updates, ownership/expiry fields stripped', () => {
  const full = updateSchema.validate(details, { stripUnknown: true });
  assert.equal(full.error, undefined);
  assert.equal(full.value.customer.email, 'customer@example.com');
  assert.equal(full.value.deliveryAddress.country, 'IN');

  assert.equal(updateSchema.validate({ customer: { phone: '+918319510666' } }).error, undefined);
  assert.ok(updateSchema.validate({}).error, 'empty body rejected');
  assert.ok(updateSchema.validate({ customer: {} }).error, 'empty group rejected');
  assert.ok(updateSchema.validate({ customer: { email: 'nope' } }).error);

  const stripped = updateSchema.validate(
    { ...details, expiresAt: '2099-01-01', anonymousCartId: 'x', sessionTokenHash: 'x' },
    { stripUnknown: true }
  ).value;
  assert.deepEqual(Object.keys(stripped).sort(), ['customer', 'deliveryAddress']);
  assert.equal(createSchema.validate(undefined).value && typeof createSchema.validate(undefined).value, 'object');
  assert.ok(createSchema.validate({ anonymousCartId: 'not-a-uuid' }).error);
});

test('tokens are 256-bit random, unique, and hashed with SHA-256', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => crypto.randomBytes(32).toString('base64url')));
  assert.equal(tokens.size, 200);
  const hash = service.hashToken('a'.repeat(43));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, 'a'.repeat(43));
});

test('authenticate rejects missing/malformed tokens without touching the database', async () => {
  for (const bad of [undefined, '', 'short', 'x'.repeat(44), `${'a'.repeat(42)}!`]) {
    await assert.rejects(() => service.authenticate(bad), { code: 'INVALID_GUEST_SESSION' });
  }
});

test('HTTP: missing, malformed token and JWT/cart id are not accepted', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/v1/guest-checkout/sessions/current`;
  const code = async (headers, method = 'GET') => {
    const res = await fetch(url, { method, headers });
    return [res.status, (await res.json()).error.code];
  };
  assert.deepEqual(await code({}), [401, 'INVALID_GUEST_SESSION']);
  assert.deepEqual(await code({ [HEADER]: 'bad' }), [401, 'INVALID_GUEST_SESSION']);
  assert.deepEqual(await code({ 'X-Anonymous-Cart-ID': crypto.randomUUID() }), [401, 'INVALID_GUEST_SESSION']);
  assert.deepEqual(await code({ Authorization: 'Bearer abc' }), [401, 'INVALID_GUEST_SESSION']);
  assert.deepEqual(await code({}, 'DELETE'), [401, 'INVALID_GUEST_SESSION']);
});

test('guest checkout API (database)', dbOpts, async (t) => {
  const db = require('../src/config/database');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1/guest-checkout/sessions`;
  const anonymousId = crypto.randomUUID();
  let cartId;

  const call = async (token, method, path = '', payload) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { [HEADER]: token } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  t.after(async () => {
    server.close();
    await db.query('DELETE FROM carts WHERE anonymous_id = $1', [anonymousId]);
    await db.close();
  });

  cartId = (await db.query(
    `INSERT INTO carts (anonymous_id, status) VALUES ($1, 'ACTIVE') RETURNING id`, [anonymousId]
  )).rows[0].id;

  let a;
  let b;
  await t.test('create sessions: token returned once, hash-only storage', async () => {
    const r = await call(null, 'POST', '/', { anonymousCartId: anonymousId });
    assert.equal(r.status, 201);
    a = r.json.data;
    assert.match(a.sessionToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(a.cartId, cartId);
    assert.notEqual(a.sessionToken, anonymousId);
    assert.ok(new Date(a.expiresAt) > new Date());
    assert.equal(a.isComplete, false);
    assert.equal(JSON.stringify(r.json).includes('hash'), false);

    const { rows } = await db.query('SELECT * FROM guest_checkout_sessions WHERE id = $1', [a.id]);
    assert.equal(rows[0].session_token_hash, service.hashToken(a.sessionToken));
    assert.ok(!Object.values(rows[0]).includes(a.sessionToken), 'raw token must not be stored');

    // Same cart again => a different, independent session (never reused).
    b = (await call(null, 'POST', '/', { anonymousCartId: anonymousId })).json.data;
    assert.notEqual(b.id, a.id);
    assert.notEqual(b.sessionToken, a.sessionToken);
  });

  await t.test('create without a cart works; unknown cart is 404', async () => {
    const r = await call(null, 'POST', '/');
    assert.equal(r.status, 201);
    assert.equal(r.json.data.cartId, null);
    await call(r.json.data.sessionToken, 'DELETE', '/current');
    assert.equal((await call(null, 'POST', '/', { anonymousCartId: crypto.randomUUID() })).status, 404);
  });

  await t.test('cart id is not a credential', async () => {
    for (const v of [cartId, anonymousId]) assert.equal((await call(v, 'GET', '/current')).status, 401);
  });

  await t.test('retrieve, then partial updates, then retrieve again', async () => {
    let r = await call(a.sessionToken, 'GET', '/current');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.customer.email, null);
    assert.equal('sessionToken' in r.json.data, false);

    const before = r.json.data.updatedAt;
    r = await call(a.sessionToken, 'PUT', '/current', { customer: details.customer });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.customer.email, 'customer@example.com');
    assert.equal(r.json.data.isComplete, false);
    assert.ok(new Date(r.json.data.updatedAt) >= new Date(before));

    r = await call(a.sessionToken, 'PUT', '/current', { deliveryAddress: details.deliveryAddress });
    assert.equal(r.json.data.deliveryAddress.country, 'IN');
    assert.equal(r.json.data.customer.firstName, 'Vikram', 'earlier details preserved');
    assert.equal(r.json.data.isComplete, true);

    r = await call(a.sessionToken, 'GET', '/current');
    assert.equal(r.json.data.deliveryAddress.city, 'Pune');
    assert.equal(r.json.data.customer.phone, '+918319510666');
  });

  await t.test('ownership/expiry cannot be changed through the request', async () => {
    const r = await call(a.sessionToken, 'PUT', '/current', {
      customer: { firstName: 'Z' }, expiresAt: '2099-01-01T00:00:00Z', anonymousCartId: crypto.randomUUID(),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.cartId, cartId);
    assert.ok(new Date(r.json.data.expiresAt) < new Date('2099-01-01'));
    assert.equal((await call(a.sessionToken, 'PUT', '/current', {})).status, 400);
  });

  await t.test('sessions are isolated from each other', async () => {
    await call(b.sessionToken, 'PUT', '/current', { customer: { firstName: 'Other' } });
    assert.equal((await call(a.sessionToken, 'GET', '/current')).json.data.customer.firstName, 'Z');
    assert.equal((await call(b.sessionToken, 'GET', '/current')).json.data.customer.firstName, 'Other');
    assert.equal((await call(b.sessionToken, 'GET', '/current')).json.data.id, b.id);
  });

  await t.test('unknown token is rejected', async () => {
    const r = await call(crypto.randomBytes(32).toString('base64url'), 'GET', '/current');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'GUEST_SESSION_NOT_FOUND');
  });

  await t.test('expired session is rejected', async () => {
    await db.query(`UPDATE guest_checkout_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [b.id]);
    for (const m of ['GET', 'DELETE']) {
      const r = await call(b.sessionToken, m, '/current');
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, 'GUEST_SESSION_EXPIRED');
    }
    assert.equal((await call(b.sessionToken, 'PUT', '/current', { customer: { firstName: 'X' } })).status, 401);
  });

  await t.test('delete removes the session but not the cart; token cannot be reused', async () => {
    assert.equal((await call(a.sessionToken, 'DELETE', '/current')).status, 200);
    const r = await call(a.sessionToken, 'GET', '/current');
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'GUEST_SESSION_NOT_FOUND');
    const { rows } = await db.query('SELECT id FROM carts WHERE id = $1', [cartId]);
    assert.equal(rows.length, 1);
  });
});
