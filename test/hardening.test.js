'use strict';

// Offline security tests (no database needed).
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { signToken } = require('../src/utils/jwt');

const listen = (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/v1`;
};
const jwt = signToken({ id: crypto.randomUUID(), email: 'sec@example.invalid' });

test('malformed UUIDs are rejected with 400, never reaching the database', async (t) => {
  const base = listen(t);
  const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
  for (const id of ['x', 'aaaaaaaa:aaaa:aaaa:aaaa:aaaaaaaaaaaa', "' OR 1=1 --", 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    for (const [method, path] of [['GET', `/addresses/${encodeURIComponent(id)}`], ['PATCH', `/addresses/${encodeURIComponent(id)}/default`]]) {
      const res = await fetch(base + path, { method, headers });
      assert.equal(res.status, 400, `${method} ${id}`);
      assert.equal((await res.json()).error.code, 'INVALID_REQUEST');
    }
  }
  const res = await fetch(`${base}/guest-checkout/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anonymousCartId: 'aaaaaaaa:aaaa:aaaa:aaaa:aaaaaaaaaaaa' }),
  });
  assert.equal(res.status, 400);
});

test('invalid or expired JWT is never downgraded', async (t) => {
  const base = listen(t);
  for (const token of ['garbage', jwt.slice(0, -2) + 'xx']) {
    for (const path of ['/addresses', '/carts/current']) {
      const res = await fetch(base + path, {
        headers: { Authorization: `Bearer ${token}`, 'X-Anonymous-Cart-ID': crypto.randomUUID() },
      });
      assert.equal(res.status, 401, `${path} with bad token must be 401, not anonymous`);
    }
  }
});

test('guest endpoints do not accept JWT or cart id as credentials', async (t) => {
  const base = listen(t);
  const res = await fetch(`${base}/guest-checkout/sessions/current`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Anonymous-Cart-ID': crypto.randomUUID() },
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'INVALID_GUEST_SESSION');
});

test('tokens and Authorization headers never appear in logs or error bodies', async (t) => {
  const base = listen(t);
  const guestToken = crypto.randomBytes(32).toString('base64url');
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  let bodies = '';
  try {
    for (const [path, headers] of [
      ['/addresses/not-a-uuid', { Authorization: `Bearer ${jwt}` }],
      ['/guest-checkout/sessions/current', { 'X-Guest-Checkout-Session': guestToken }],
      ['/guest-checkout/sessions/current', { 'X-Guest-Checkout-Session': 'bad-token' }],
    ]) {
      const res = await fetch(base + path, { headers });
      bodies += await res.text();
    }
  } catch (err) {
    lines.push(String(err));
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  const everything = lines.join('\n') + bodies;
  assert.ok(lines.length > 0, 'requests were logged');
  for (const secret of [jwt, guestToken, 'bad-token']) {
    assert.equal(everything.includes(secret), false);
  }
});

test('create endpoint is rate limited', async (t) => {
  const base = listen(t);
  const env = require('../src/config/env');
  let last;
  // Invalid body => 400 before any database access, but the limiter runs first.
  for (let i = 0; i <= env.authRateLimit.max; i += 1) {
    last = await fetch(`${base}/guest-checkout/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymousCartId: 'bad' }),
    });
  }
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error.code, 'RATE_LIMITED');
});
