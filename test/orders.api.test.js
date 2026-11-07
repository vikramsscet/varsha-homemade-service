'use strict';

// Integration tests: write to DATABASE_URL (migrations 001-008 applied); only run with RUN_DB_TESTS=1.
// The Product CMS and Razorpay are stubbed, so no network access is needed.
// Cleanup note: payment_transactions is append-only, so teardown briefly disables that trigger.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };

const P1 = '11111111-1111-4111-8111-111111111111'; // 249.00
const P2 = '22222222-2222-4222-8222-222222222222'; // 599.50

test('order creation and Razorpay order API (database)', opts, async (t) => {
  const app = require('../src/app');
  const db = require('../src/config/database');
  const { signToken } = require('../src/utils/jwt');
  const { productServiceClient } = require('../src/integrations/product');
  const razorpay = require('../src/integrations/razorpay');
  const { CATALOG } = require('../src/integrations/product/mockProductServiceClient');

  const prices = new Map(CATALOG.map((p) => [p.productId, { ...p }]));
  t.mock.method(productServiceClient, 'getProduct', async (id) => (prices.get(id) ? { ...prices.get(id) } : null));
  let rzpCalls = [];
  t.mock.method(razorpay, 'getKeyId', () => 'rzp_test_unit');
  t.mock.method(razorpay, 'createOrder', async (p) => {
    rzpCalls.push(p);
    return { id: `order_${crypto.randomBytes(8).toString('hex')}`, amount: p.amount, currency: p.currency, status: 'created', receipt: p.receipt };
  });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now();
  const userIds = [];
  const cartIds = [];
  const sessionIds = [];

  t.after(async () => {
    server.close();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE payment_transactions DISABLE TRIGGER trg_payment_transactions_immutable');
      const orders = (await client.query('SELECT id FROM orders WHERE user_id = ANY($1) OR cart_id = ANY($2)', [userIds, cartIds])).rows.map((r) => r.id);
      await client.query('DELETE FROM payment_transactions WHERE payment_id IN (SELECT id FROM payments WHERE order_id = ANY($1))', [orders]);
      await client.query('DELETE FROM payments WHERE order_id = ANY($1)', [orders]);
      await client.query('DELETE FROM order_items WHERE order_id = ANY($1)', [orders]);
      await client.query('DELETE FROM orders WHERE id = ANY($1)', [orders]);
      await client.query('ALTER TABLE payment_transactions ENABLE TRIGGER trg_payment_transactions_immutable');
      await client.query('DELETE FROM guest_checkout_sessions WHERE id = ANY($1)', [sessionIds]);
      await client.query('DELETE FROM carts WHERE id = ANY($1)', [cartIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
      await db.close();
    }
  });

  const call = async (path, { headers = {}, body, method = 'POST' } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
    return { status: res.status, json: await res.json() };
  };

  const makeUser = async (label) => {
    const { rows } = await db.query(`INSERT INTO users (email, first_name) VALUES ($1,'T') RETURNING id, email`, [`ord-${label}-${suffix}@example.invalid`]);
    userIds.push(rows[0].id);
    const addr = await db.query(
      `INSERT INTO user_addresses (user_id, first_name, last_name, phone, country, address_line1, city, state, postal_code, is_default)
       VALUES ($1,'A','B','+918319510666','IN','Street 1','Pune','MH','411057',TRUE) RETURNING id`, [rows[0].id]);
    const cart = await db.query(`INSERT INTO carts (user_id) VALUES ($1) RETURNING id`, [rows[0].id]);
    cartIds.push(cart.rows[0].id);
    return { id: rows[0].id, auth: { Authorization: `Bearer ${signToken(rows[0])}` }, addressId: addr.rows[0].id, cartId: cart.rows[0].id };
  };
  const addItem = (cartId, productId, quantity, price = '1.00') =>
    db.query(
      `INSERT INTO cart_items (cart_id, product_id, product_name, product_slug, unit_price, quantity, total_price)
       VALUES ($1,$2,'n','s',$3,$4,$3 * $4)`, [cartId, productId, price, quantity]);
  const count = async (sql, params) => (await db.query(sql, params)).rows[0].n;

  await t.test('authenticated: server-calculated total, snapshots, cart untouched, amount ignored', async () => {
    const u = await makeUser('a');
    await addItem(u.cartId, P1, 2, '0.01'); // stale cart price must be ignored
    await addItem(u.cartId, P2, 1);
    const r = await call('/orders', { headers: u.auth, body: { addressId: u.addressId, amount: 1, totalAmount: 1 } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.data.totalAmount, 1097.5); // 2*249.00 + 599.50
    assert.equal(r.json.data.amountInPaise, 109750);
    assert.equal(r.json.data.status, 'PENDING_PAYMENT');
    assert.equal(r.json.data.customer.email, `ord-a-${suffix}@example.invalid`);
    assert.equal(r.json.data.items.length, 2);
    assert.equal(r.json.data.guestAccessToken, undefined);
    assert.equal(await count(`SELECT COUNT(*)::int n FROM cart_items WHERE cart_id=$1`, [u.cartId]), 2);
    assert.equal((await db.query('SELECT status FROM carts WHERE id=$1', [u.cartId])).rows[0].status, 'ACTIVE');
  });

  await t.test('rejects empty cart, unavailable product, foreign address, missing address', async () => {
    const u = await makeUser('b');
    let r = await call('/orders', { headers: u.auth, body: { addressId: u.addressId } });
    assert.equal(r.json.error.code, 'CART_EMPTY');
    await addItem(u.cartId, '99999999-9999-4999-8999-999999999999', 1);
    r = await call('/orders', { headers: u.auth, body: { addressId: u.addressId } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'PRODUCT_UNAVAILABLE');
    const other = await makeUser('b2');
    r = await call('/orders', { headers: u.auth, body: { addressId: other.addressId } });
    assert.equal(r.json.error.code, 'ADDRESS_NOT_FOUND');
    r = await call('/orders', { headers: u.auth, body: {} });
    assert.equal(r.json.error.code, 'ADDRESS_REQUIRED');
  });

  await t.test('duplicate protection: same cart -> same order; concurrent -> one order; changed cart supersedes', async () => {
    const u = await makeUser('c');
    await addItem(u.cartId, P1, 1);
    const body = { addressId: u.addressId };
    const results = await Promise.all(Array.from({ length: 6 }, () => call('/orders', { headers: u.auth, body })));
    assert.ok(results.every((r) => [200, 201].includes(r.status)), JSON.stringify(results.map((r) => r.json)));
    assert.equal(new Set(results.map((r) => r.json.data.id)).size, 1);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(await count('SELECT COUNT(*)::int n FROM orders WHERE cart_id=$1', [u.cartId]), 1);

    const key = `key-${suffix}-c1`;
    const k1 = await call('/orders', { headers: { ...u.auth, 'Idempotency-Key': key }, body });
    const k2 = await call('/orders', { headers: { ...u.auth, 'Idempotency-Key': key }, body });
    assert.equal(k1.json.data.id, k2.json.data.id);
    assert.equal(k2.status, 200);

    // price change in the CMS -> new order, old one cancelled, still only one open order
    prices.get(P1).unitPrice = '300.00';
    const changed = await call('/orders', { headers: u.auth, body });
    prices.get(P1).unitPrice = '249.00';
    assert.equal(changed.status, 201);
    assert.notEqual(changed.json.data.id, results[0].json.data.id);
    assert.equal(changed.json.data.totalAmount, 300);
    assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [results[0].json.data.id])).rows[0].status, 'CANCELLED');
    assert.equal(await count(`SELECT COUNT(*)::int n FROM orders WHERE cart_id=$1 AND status='PENDING_PAYMENT'`, [u.cartId]), 1);
  });

  await t.test('payment order: created once, reused, retried after failure, ownership enforced, ledger written', async () => {
    const u = await makeUser('d');
    const intruder = await makeUser('d2');
    await addItem(u.cartId, P2, 2);
    const order = (await call('/orders', { headers: u.auth, body: { addressId: u.addressId } })).json.data;
    rzpCalls = [];

    const first = await call('/payments/create-order', { headers: u.auth, body: { orderId: order.id, amount: 1, currency: 'USD' } });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const d = first.json.data;
    assert.equal(d.orderId, order.id);
    assert.equal(d.amount, 119900);
    assert.equal(d.currency, 'INR');
    assert.equal(d.razorpayKeyId, 'rzp_test_unit');
    assert.match(d.razorpayOrderId, /^order_/);
    assert.ok(d.paymentId);
    assert.ok(!JSON.stringify(first.json).toLowerCase().includes('secret'));
    assert.equal(rzpCalls[0].amount, 119900);
    assert.equal(rzpCalls[0].notes.internalOrderId, order.id);

    const conc = await Promise.all(Array.from({ length: 5 }, () => call('/payments/create-order', { headers: u.auth, body: { orderId: order.id } })));
    assert.ok(conc.every((r) => r.status === 200 && r.json.data.razorpayOrderId === d.razorpayOrderId));
    assert.equal(rzpCalls.length, 1, 'Razorpay order created exactly once');
    assert.equal(await count('SELECT COUNT(*)::int n FROM payments WHERE order_id=$1', [order.id]), 1);
    assert.equal(await count(`SELECT COUNT(*)::int n FROM payment_transactions WHERE payment_id=$1 AND type='ATTEMPT'`, [d.paymentId]), 1);

    assert.equal((await call('/payments/create-order', { headers: intruder.auth, body: { orderId: order.id } })).json.error.code, 'ORDER_NOT_FOUND');

    // simulate a failed attempt (verification/webhooks arrive in a later phase) -> retry creates attempt 2
    await db.query(`UPDATE payments SET status='FAILED', failed_at=NOW() WHERE id=$1`, [d.paymentId]);
    await db.query(`UPDATE orders SET status='PAYMENT_FAILED' WHERE id=$1`, [order.id]);
    const retry = await call('/payments/create-order', { headers: u.auth, body: { orderId: order.id } });
    assert.equal(retry.status, 201);
    assert.equal(retry.json.data.attemptNumber, 2);
    assert.notEqual(retry.json.data.razorpayOrderId, d.razorpayOrderId);

    // paid orders cannot be paid again
    await db.query(`UPDATE payments SET status='CAPTURED', razorpay_payment_id='pay_test', captured_at=NOW() WHERE id=$1`, [retry.json.data.paymentId]);
    await db.query(`UPDATE orders SET status='PAID', paid_at=NOW(), confirmed_at=NOW() WHERE id=$1`, [order.id]);
    const again = await call('/payments/create-order', { headers: u.auth, body: { orderId: order.id } });
    assert.equal(again.json.error.code, 'ORDER_ALREADY_PAID');
    const reorder = await call('/orders', { headers: u.auth, body: { addressId: u.addressId } });
    assert.equal(reorder.json.error.code, 'CART_ALREADY_ORDERED');
  });

  await t.test('guest checkout: order from session, token returned once, payment via session or order token', async () => {
    const anonymousId = crypto.randomUUID();
    const cart = await db.query(`INSERT INTO carts (anonymous_id, expires_at) VALUES ($1, NOW() + interval '1 day') RETURNING id`, [anonymousId]);
    cartIds.push(cart.rows[0].id);
    await addItem(cart.rows[0].id, P1, 1);
    const sess = await call('/guest-checkout/sessions', { body: { anonymousCartId: anonymousId } });
    assert.equal(sess.status, 201, JSON.stringify(sess.json));
    sessionIds.push(sess.json.data.id);
    const guest = { 'X-Guest-Checkout-Session': sess.json.data.sessionToken };

    let r = await call('/orders', { headers: guest });
    assert.equal(r.json.error.code, 'CHECKOUT_DETAILS_INCOMPLETE');
    await fetch(`${base}/guest-checkout/sessions/current`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...guest },
      body: JSON.stringify({
        customer: { email: 'guest@example.invalid', firstName: 'G', lastName: 'U', phone: '+918319510666' },
        deliveryAddress: { country: 'IN', addressLine1: 'Street', city: 'Pune', state: 'MH', postalCode: '411057' },
      }),
    });
    r = await call('/orders', { headers: guest });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.data.customerType, 'GUEST');
    assert.equal(r.json.data.totalAmount, 249);
    const token = r.json.data.guestAccessToken;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const replay = await call('/orders', { headers: guest });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.guestAccessToken, undefined);
    assert.equal((await db.query('SELECT guest_access_token_hash h FROM orders WHERE id=$1', [r.json.data.id])).rows[0].h.length, 64);

    const viaSession = await call('/payments/create-order', { headers: guest, body: { orderId: r.json.data.id } });
    assert.equal(viaSession.status, 201);
    const viaToken = await call('/payments/create-order', { headers: { 'X-Guest-Order-Token': token }, body: { orderId: r.json.data.id } });
    assert.equal(viaToken.status, 200);
    assert.equal(viaToken.json.data.paymentId, viaSession.json.data.paymentId);
    const wrong = await call('/payments/create-order', { headers: { 'X-Guest-Order-Token': crypto.randomBytes(32).toString('base64url') }, body: { orderId: r.json.data.id } });
    assert.equal(wrong.json.error.code, 'ORDER_NOT_FOUND');
    assert.equal((await db.query('SELECT status FROM carts WHERE id=$1', [cart.rows[0].id])).rows[0].status, 'ACTIVE');
  });
});
