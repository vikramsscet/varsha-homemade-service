'use strict';

// Integration tests. They write to the database named by DATABASE_URL (they create and delete
// their own users, which cascades to addresses), so they only run when RUN_DB_TESTS=1.
// Migration 003 must already be applied.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };

const body = (over = {}) => ({
  firstName: 'Vikram', lastName: 'Rao', phone: '+918319510666', country: 'India',
  addressLine1: 'Beverly Hills Society', addressLine2: 'Building A, Flat 101',
  city: 'Pune', state: 'Maharashtra', postalCode: '411057', ...over,
});

test('address API', opts, async (t) => {
  const app = require('../src/app');
  const db = require('../src/config/database');
  const { signToken } = require('../src/utils/jwt');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1/addresses`;
  const suffix = Date.now();
  const users = [];

  const makeUser = async (label) => {
    const { rows } = await db.query(
      `INSERT INTO users (email, first_name) VALUES ($1, 'T') RETURNING id, email`,
      [`addr-test-${label}-${suffix}@example.invalid`]
    );
    users.push(rows[0].id);
    return { id: rows[0].id, token: signToken(rows[0]) };
  };
  const call = async (user, method, path = '', payload) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  const defaults = (list) => list.filter((a) => a.isDefault);

  t.after(async () => {
    server.close();
    if (users.length) await db.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await db.close();
  });

  const alice = await makeUser('alice');
  const bob = await makeUser('bob');

  await t.test('requires authentication', async () => {
    assert.equal((await call(null, 'GET')).status, 401);
    assert.equal((await call(null, 'POST', '', body())).status, 401);
  });

  await t.test('empty list for a new user', async () => {
    const r = await call(alice, 'GET');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, []);
  });

  let first;
  await t.test('first address becomes default even if isDefault=false', async () => {
    const r = await call(alice, 'POST', '', body({ isDefault: false }));
    assert.equal(r.status, 201);
    assert.equal(r.json.data.isDefault, true);
    assert.equal(r.json.data.country, 'IN');
    first = r.json.data;
  });

  let second;
  await t.test('second address is not default unless requested', async () => {
    const r = await call(alice, 'POST', '', body({ addressLine1: 'Second' }));
    assert.equal(r.json.data.isDefault, false);
    second = r.json.data;
  });

  await t.test('creating with isDefault=true unsets the previous default', async () => {
    const r = await call(alice, 'POST', '', body({ addressLine1: 'Third', isDefault: true }));
    assert.equal(r.json.data.isDefault, true);
    const list = (await call(alice, 'GET')).json.data;
    assert.equal(list.length, 3);
    assert.equal(defaults(list).length, 1);
    assert.equal(list[0].id, r.json.data.id, 'default sorts first');
  });

  await t.test('get by id and validation errors', async () => {
    const r = await call(alice, 'GET', `/${first.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.id, first.id);
    assert.equal((await call(alice, 'GET', '/not-a-uuid')).status, 400);
    const bad = await call(alice, 'POST', '', body({ city: '' }));
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_REQUEST');
  });

  await t.test('user_id in the body is ignored', async () => {
    const r = await call(alice, 'POST', '', body({ userId: bob.id, addressLine1: 'Sneaky' }));
    assert.equal(r.status, 201);
    assert.equal((await call(bob, 'GET')).json.data.length, 0);
  });

  await t.test('set default via PATCH', async () => {
    const r = await call(alice, 'PATCH', `/${second.id}/default`);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.id, second.id);
    assert.equal(r.json.data.isDefault, true);
    assert.equal(defaults((await call(alice, 'GET')).json.data).length, 1);
  });

  await t.test('update address, change default, and refuse to unset the default', async () => {
    let r = await call(alice, 'PUT', `/${first.id}`, body({ city: 'Mumbai', isDefault: true }));
    assert.equal(r.status, 200);
    assert.equal(r.json.data.city, 'Mumbai');
    assert.equal(r.json.data.isDefault, true);
    assert.equal(defaults((await call(alice, 'GET')).json.data).length, 1);

    r = await call(alice, 'PUT', `/${first.id}`, body({ isDefault: false }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'INVALID_ADDRESS');
  });

  await t.test('cross-user access returns 404', async () => {
    for (const [m, p, b] of [
      ['GET', `/${first.id}`], ['PUT', `/${first.id}`, body()],
      ['PATCH', `/${first.id}/default`], ['DELETE', `/${first.id}`],
    ]) {
      const r = await call(bob, m, p, b);
      assert.equal(r.status, 404, `${m} should be 404`);
      assert.equal(r.json.error.code, 'ADDRESS_NOT_FOUND');
    }
    assert.equal((await call(alice, 'GET', `/${first.id}`)).status, 200);
  });

  await t.test('deleting a non-default address keeps the default', async () => {
    const r = await call(alice, 'DELETE', `/${second.id}`);
    assert.equal(r.status, 200);
    const list = (await call(alice, 'GET')).json.data;
    assert.equal(defaults(list).length, 1);
    assert.equal(defaults(list)[0].id, first.id);
  });

  await t.test('deleting the default promotes another; deleting the last leaves none', async () => {
    let r = await call(alice, 'DELETE', `/${first.id}`);
    assert.equal(r.status, 200);
    let list = (await call(alice, 'GET')).json.data;
    assert.equal(list.length, 2);
    assert.equal(defaults(list).length, 1);
    for (const a of list) await call(alice, 'DELETE', `/${a.id}`);
    list = (await call(alice, 'GET')).json.data;
    assert.deepEqual(list, []);
    r = await call(alice, 'DELETE', `/${first.id}`);
    assert.equal(r.status, 404);
  });

  await t.test('concurrent first-address creates yield exactly one default', async () => {
    const carol = await makeUser('carol');
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      call(carol, 'POST', '', body({ addressLine1: `C${i}` }))));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(defaults((await call(carol, 'GET')).json.data).length, 1);
  });

  await t.test('concurrent default changes keep exactly one default', async () => {
    const dave = await makeUser('dave');
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await call(dave, 'POST', '', body({ addressLine1: `D${i}` }))).json.data.id);
    const rs = await Promise.all([
      ...ids.map((id) => call(dave, 'PATCH', `/${id}/default`)),
      ...ids.map((id) => call(dave, 'PUT', `/${id}`, body({ isDefault: true }))),
    ]);
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(defaults((await call(dave, 'GET')).json.data).length, 1);
  });
});
