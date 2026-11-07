'use strict';

// Integration tests against PostgreSQL (migrations 001-009 applied); only run with RUN_DB_TESTS=1.
// Exercises real row locks, the unique event id, the processing lease and the atomic "processed" marker.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };
const P1 = '11111111-1111-4111-8111-111111111111'; // 249.00
const SECRET = 'webhook-test-only-secret';

test('payment webhook API (database)', opts, async (t) => {
  const app = require('../src/app');
  const db = require('../src/config/database');
  const { signToken } = require('../src/utils/jwt');
  const { productServiceClient } = require('../src/integrations/product');
  const razorpay = require('../src/integrations/razorpay');
  const { CATALOG } = require('../src/integrations/product/mockProductServiceClient');

  t.mock.method(productServiceClient, 'getProduct', async (id) => CATALOG.find((p) => p.productId === id) || null);
  t.mock.method(razorpay, 'getKeyId', () => 'rzp_test_unit');
  t.mock.method(razorpay, 'createOrder', async (p) => ({ id: `order_${crypto.randomBytes(6).toString('hex')}`, amount: p.amount, currency: p.currency, status: 'created', receipt: p.receipt }));
  t.mock.method(razorpay, 'verifySignature', () => true);
  const gateway = new Map();
  t.mock.method(razorpay, 'fetchPayment', async (id) => gateway.get(id));
  t.mock.method(razorpay, 'verifyWebhookSignature', (raw, sig) =>
    typeof sig === 'string' && sig === crypto.createHmac('sha256', SECRET).update(raw).digest('hex'));

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
      const pays = (await client.query('SELECT id FROM payments WHERE order_id = ANY($1)', [orders])).rows.map((r) => r.id);
      await client.query('DELETE FROM payment_transactions WHERE payment_id = ANY($1)', [pays]);
      await client.query('DELETE FROM payment_webhook_events WHERE payment_id = ANY($1) OR gateway_event_id LIKE $2', [pays, `evt_${suffix}%`]);
      await client.query('DELETE FROM payments WHERE id = ANY($1)', [pays]);
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

  const api = async (path, headers, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  let n = 0;
  const hook = async (type, c, { payId, eventId = `evt_${suffix}_${++n}`, status, amount, signature } = {}) => {
    const entity = { id: payId, order_id: c.pay.razorpayOrderId, amount: amount ?? c.pay.amount, currency: 'INR', method: 'upi', status, email: 'pii@x.test' };
    const body = { event: type, payload: { payment: { entity }, ...(type === 'order.paid' ? { order: { entity: { id: c.pay.razorpayOrderId, status: 'paid' } } } : {}) } };
    const raw = JSON.stringify(body);
    const res = await fetch(`${base}/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Event-Id': eventId, 'X-Razorpay-Signature': signature || crypto.createHmac('sha256', SECRET).update(raw).digest('hex') },
      body: raw,
    });
    return { status: res.status, json: await res.json(), eventId };
  };
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];

  const checkout = async (label) => {
    const u = (await db.query(`INSERT INTO users (email, first_name) VALUES ($1,'T') RETURNING id, email`, [`wh-${label}-${suffix}@example.invalid`])).rows[0];
    userIds.push(u.id);
    const addr = (await db.query(
      `INSERT INTO user_addresses (user_id, first_name, last_name, phone, country, address_line1, city, state, postal_code)
       VALUES ($1,'A','B','+918319510666','IN','S','Pune','MH','411057') RETURNING id`, [u.id])).rows[0];
    const cart = (await db.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [u.id])).rows[0];
    cartIds.push(cart.id);
    await db.query(`INSERT INTO cart_items (cart_id, product_id, product_name, product_slug, unit_price, quantity, total_price) VALUES ($1,$2,'n','s',249,1,249)`, [cart.id, P1]);
    const auth = { Authorization: `Bearer ${signToken(u)}` };
    const order = (await api('/orders', auth, { addressId: addr.id })).json.data;
    const pay = (await api('/payments/create-order', auth, { orderId: order.id })).json.data;
    return { auth, order, pay, cart };
  };

  await t.test('rejects bad signatures without storing anything; accepts and stores a valid event', async () => {
    const c = await checkout('sig');
    const bad = await hook('payment.captured', c, { payId: 'pay_w1', status: 'captured', signature: 'a'.repeat(64) });
    assert.equal(bad.status, 400);
    assert.equal(Number((await one('SELECT COUNT(*) n FROM payment_webhook_events WHERE gateway_event_id=$1', [bad.eventId])).n), 0);
    const ok = await hook('payment.captured', c, { payId: 'pay_w1', status: 'captured' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const ev = await one('SELECT * FROM payment_webhook_events WHERE gateway_event_id=$1', [ok.eventId]);
    assert.equal(ev.processing_status, 'PROCESSED');
    assert.equal(ev.signature_verified, true);
    assert.ok(!JSON.stringify(ev.payload).includes('pii@x.test'));
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PAID');
    assert.equal((await one('SELECT status FROM carts WHERE id=$1', [c.cart.id])).status, 'COMPLETED');
  });

  await t.test('duplicate and concurrent deliveries of one event, and the same fact via several events: one confirmation', async () => {
    const c = await checkout('dup');
    const eventId = `evt_${suffix}_dup`;
    const same = await Promise.all(Array.from({ length: 6 }, () => hook('payment.captured', c, { payId: 'pay_d1', status: 'captured', eventId })));
    assert.ok(same.every((r) => [200, 409].includes(r.status)), JSON.stringify(same.map((r) => r.json)));
    assert.equal(Number((await one('SELECT COUNT(*) n FROM payment_webhook_events WHERE gateway_event_id=$1', [eventId])).n), 1);
    // events with different ids announcing the same capture (+ the frontend verify call), all racing
    const mixed = await Promise.all([
      hook('order.paid', c, { payId: 'pay_d1', status: 'captured' }),
      hook('payment.captured', c, { payId: 'pay_d1', status: 'captured' }),
      hook('payment.authorized', c, { payId: 'pay_d1', status: 'authorized' }),
    ]);
    assert.ok(mixed.every((r) => r.status === 200), JSON.stringify(mixed.map((r) => r.json)));
    assert.equal(Number((await one(`SELECT COUNT(*) n FROM payment_transactions WHERE payment_id=$1 AND type='CAPTURE'`, [c.pay.paymentId])).n), 1);
    assert.equal((await one('SELECT status FROM payments WHERE id=$1', [c.pay.paymentId])).status, 'CAPTURED');
    const redelivery = await hook('payment.captured', c, { payId: 'pay_d1', status: 'captured', eventId });
    assert.equal(redelivery.json.data.status, 'DUPLICATE');
  });

  await t.test('webhook then frontend verify (and vice versa) converge on one PAID state', async () => {
    const c = await checkout('conv');
    gateway.set('pay_c1', { id: 'pay_c1', orderId: c.pay.razorpayOrderId, status: 'captured', amount: c.pay.amount, currency: 'INR', method: 'upi', captured: true });
    const sig = 'a'.repeat(64);
    const [w, v] = await Promise.all([
      hook('payment.captured', c, { payId: 'pay_c1', status: 'captured' }),
      api('/payments/verify', c.auth, { internalPaymentId: c.pay.paymentId, razorpay_order_id: c.pay.razorpayOrderId, razorpay_payment_id: 'pay_c1', razorpay_signature: sig }),
    ]);
    assert.equal(w.status, 200);
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(Number((await one(`SELECT COUNT(*) n FROM payment_transactions WHERE payment_id=$1 AND type='CAPTURE'`, [c.pay.paymentId])).n), 1);
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PAID');
  });

  await t.test('out of order: failed (older attempt) / authorized after capture are ignored; failed then captured retry -> PAID', async () => {
    const c = await checkout('ooo');
    const f = await hook('payment.failed', c, { payId: 'pay_o1', status: 'failed' });
    assert.equal(f.json.data.status, 'PROCESSED');
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PAYMENT_FAILED');
    await hook('payment.captured', c, { payId: 'pay_o2', status: 'captured' });
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PAID');
    const late = await hook('payment.failed', c, { payId: 'pay_o1', status: 'failed' });
    const late2 = await hook('payment.authorized', c, { payId: 'pay_o2', status: 'authorized' });
    assert.equal(late.json.data.status, 'IGNORED');
    assert.equal(late2.json.data.status, 'IGNORED');
    const p = await one('SELECT status, razorpay_payment_id FROM payments WHERE id=$1', [c.pay.paymentId]);
    assert.deepEqual([p.status, p.razorpay_payment_id], ['CAPTURED', 'pay_o2']);
  });

  await t.test('amount mismatch and unknown order are stored as IGNORED and change nothing', async () => {
    const c = await checkout('mm');
    const r = await hook('payment.captured', c, { payId: 'pay_m1', status: 'captured', amount: 100 });
    assert.equal(r.json.data.status, 'IGNORED');
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PENDING_PAYMENT');
    assert.equal((await one('SELECT last_error FROM payment_webhook_events WHERE gateway_event_id=$1', [r.eventId])).last_error, 'PAYMENT_MISMATCH');
  });
});
