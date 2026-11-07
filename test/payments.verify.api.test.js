'use strict';

// Integration tests (real PostgreSQL row locks and constraints; migrations 001-008 applied). Only run
// with RUN_DB_TESTS=1. Product CMS and Razorpay are stubbed; the signature check is real HMAC.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };
const P1 = '11111111-1111-4111-8111-111111111111'; // 249.00
const SECRET = 'test-only-secret';

test('payment verification API (database)', opts, async (t) => {
  const app = require('../src/app');
  const db = require('../src/config/database');
  const { signToken } = require('../src/utils/jwt');
  const { productServiceClient } = require('../src/integrations/product');
  const razorpay = require('../src/integrations/razorpay');
  const { CATALOG } = require('../src/integrations/product/mockProductServiceClient');

  const gateway = new Map(); // razorpay payment id -> fake gateway record
  t.mock.method(productServiceClient, 'getProduct', async (id) => CATALOG.find((p) => p.productId === id) || null);
  t.mock.method(razorpay, 'getKeyId', () => 'rzp_test_unit');
  t.mock.method(razorpay, 'createOrder', async (p) => ({ id: `order_${crypto.randomBytes(6).toString('hex')}`, amount: p.amount, currency: p.currency, status: 'created', receipt: p.receipt }));
  t.mock.method(razorpay, 'verifySignature', ({ razorpayOrderId, razorpayPaymentId, signature }) =>
    signature === crypto.createHmac('sha256', SECRET).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex'));
  t.mock.method(razorpay, 'fetchPayment', async (id) => gateway.get(id));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now();
  const userIds = [];
  const cartIds = [];

  t.after(async () => {
    server.close();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE payment_transactions DISABLE TRIGGER trg_payment_transactions_immutable');
      const orders = (await client.query('SELECT id FROM orders WHERE user_id = ANY($1)', [userIds])).rows.map((r) => r.id);
      await client.query('DELETE FROM payment_transactions WHERE payment_id IN (SELECT id FROM payments WHERE order_id = ANY($1))', [orders]);
      await client.query('DELETE FROM payments WHERE order_id = ANY($1)', [orders]);
      await client.query('DELETE FROM order_items WHERE order_id = ANY($1)', [orders]);
      await client.query('DELETE FROM orders WHERE id = ANY($1)', [orders]);
      await client.query('ALTER TABLE payment_transactions ENABLE TRIGGER trg_payment_transactions_immutable');
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

  const call = async (path, headers, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const sign = (o, p) => crypto.createHmac('sha256', SECRET).update(`${o}|${p}`).digest('hex');

  // user + cart + order + payment attempt
  const checkout = async (label) => {
    const u = (await db.query(`INSERT INTO users (email, first_name) VALUES ($1,'T') RETURNING id, email`, [`ver-${label}-${suffix}@example.invalid`])).rows[0];
    userIds.push(u.id);
    const addr = (await db.query(
      `INSERT INTO user_addresses (user_id, first_name, last_name, phone, country, address_line1, city, state, postal_code)
       VALUES ($1,'A','B','+918319510666','IN','S','Pune','MH','411057') RETURNING id`, [u.id])).rows[0];
    const cart = (await db.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [u.id])).rows[0];
    cartIds.push(cart.id);
    await db.query(`INSERT INTO cart_items (cart_id, product_id, product_name, product_slug, unit_price, quantity, total_price) VALUES ($1,$2,'n','s',249,1,249)`, [cart.id, P1]);
    const auth = { Authorization: `Bearer ${signToken(u)}` };
    const order = (await call('/orders', auth, { addressId: addr.id })).json.data;
    const pay = (await call('/payments/create-order', auth, { orderId: order.id })).json.data;
    const payload = (payId, over = {}) => ({ internalPaymentId: pay.paymentId, razorpay_order_id: pay.razorpayOrderId, razorpay_payment_id: payId, razorpay_signature: sign(pay.razorpayOrderId, payId), ...over });
    const fake = (payId, over = {}) => gateway.set(payId, { id: payId, orderId: pay.razorpayOrderId, status: 'captured', amount: pay.amount, currency: 'INR', method: 'upi', captured: true, errorCode: null, errorDescription: null, ...over });
    return { auth, order, pay, cart, payload, fake };
  };
  const row = async (sql, p) => (await db.query(sql, p)).rows[0];

  await t.test('success, then duplicate and concurrent verification confirm the order once', async () => {
    const c = await checkout('ok');
    c.fake('pay_ok1');
    const r = await call('/payments/verify', c.auth, c.payload('pay_ok1'));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.data.orderStatus, 'PAID');
    assert.equal(r.json.data.paymentStatus, 'CAPTURED');
    const before = await row('SELECT confirmed_at, paid_at FROM orders WHERE id=$1', [c.order.id]);
    assert.equal((await row('SELECT status FROM carts WHERE id=$1', [c.cart.id])).status, 'COMPLETED');
    assert.equal(Number((await row('SELECT COUNT(*) n FROM cart_items WHERE cart_id=$1', [c.cart.id])).n), 1, 'cart items are kept');

    const results = await Promise.all(Array.from({ length: 6 }, () => call('/payments/verify', c.auth, c.payload('pay_ok1'))));
    assert.ok(results.every((x) => x.status === 200 && x.json.data.alreadyProcessed === true));
    const after = await row('SELECT confirmed_at, paid_at FROM orders WHERE id=$1', [c.order.id]);
    assert.deepEqual(after, before);
    assert.equal(Number((await row(`SELECT COUNT(*) n FROM payment_transactions WHERE payment_id=$1 AND type='CAPTURE'`, [c.pay.paymentId])).n), 1);
  });

  await t.test('concurrent first-time verification: one confirmation, no error', async () => {
    const c = await checkout('conc');
    c.fake('pay_conc1');
    const results = await Promise.all(Array.from({ length: 6 }, () => call('/payments/verify', c.auth, c.payload('pay_conc1'))));
    assert.ok(results.every((x) => x.status === 200), JSON.stringify(results.map((x) => x.json)));
    assert.equal(results.filter((x) => !x.json.data.alreadyProcessed).length, 1);
  });

  await t.test('invalid signature, wrong razorpay order, unknown payment, foreign payment', async () => {
    const c = await checkout('bad');
    c.fake('pay_bad1');
    let r = await call('/payments/verify', c.auth, c.payload('pay_bad1', { razorpay_signature: 'a'.repeat(64) }));
    assert.deepEqual([r.status, r.json.error.code], [400, 'INVALID_SIGNATURE']);
    r = await call('/payments/verify', c.auth, c.payload('pay_bad1', { razorpay_order_id: 'order_WRONG1' }));
    assert.deepEqual([r.status, r.json.error.code], [400, 'RAZORPAY_ORDER_MISMATCH']);
    r = await call('/payments/verify', c.auth, c.payload('pay_bad1', { internalPaymentId: crypto.randomUUID() }));
    assert.deepEqual([r.status, r.json.error.code], [404, 'PAYMENT_NOT_FOUND']);
    const other = { Authorization: `Bearer ${signToken(await row(`INSERT INTO users (email) VALUES ($1) RETURNING id, email`, [`ver-other-${suffix}@example.invalid`]).then((u) => { userIds.push(u.id); return u; }))}` };
    r = await call('/payments/verify', other, c.payload('pay_bad1'));
    assert.equal(r.json.error.code, 'PAYMENT_NOT_FOUND');
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PENDING_PAYMENT');
    assert.ok(Number((await row(`SELECT COUNT(*) n FROM payment_transactions WHERE payment_id=$1 AND error_code='INVALID_SIGNATURE'`, [c.pay.paymentId])).n) >= 1);
  });

  await t.test('not captured -> 202 unpaid; later captured -> paid; failed -> 402 and retry creates attempt 2', async () => {
    const c = await checkout('flow');
    c.fake('pay_f1', { status: 'authorized', captured: false });
    let r = await call('/payments/verify', c.auth, c.payload('pay_f1'));
    assert.equal(r.status, 202);
    assert.equal(r.json.data.paid, false);
    assert.equal(r.json.data.paymentStatus, 'AUTHORIZED');
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PENDING_PAYMENT');

    c.fake('pay_f1', { status: 'failed', captured: false, errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'declined' });
    r = await call('/payments/verify', c.auth, c.payload('pay_f1'));
    assert.deepEqual([r.status, r.json.error.code], [402, 'PAYMENT_FAILED']);
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PAYMENT_FAILED');
    assert.equal((await row('SELECT status FROM payments WHERE id=$1', [c.pay.paymentId])).status, 'FAILED');

    const retry = await call('/payments/create-order', c.auth, { orderId: c.order.id });
    assert.equal(retry.status, 201);
    assert.equal(retry.json.data.attemptNumber, 2);
  });

  await t.test('mismatching gateway amount is rejected; claimed success fields are ignored', async () => {
    const c = await checkout('amt');
    c.fake('pay_amt1', { amount: 100 });
    let r = await call('/payments/verify', c.auth, { ...c.payload('pay_amt1'), status: 'captured', paid: true });
    assert.deepEqual([r.status, r.json.error.code], [409, 'PAYMENT_MISMATCH']);
    assert.equal((await row('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PENDING_PAYMENT');
  });
});
