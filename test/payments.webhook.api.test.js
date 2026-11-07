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
  const hook = async (type, c, { payId, eventId = `evt_${suffix}_${++n}`, status, amount, signature, extra = {} } = {}) => {
    const entity = { id: payId, order_id: c.pay.razorpayOrderId, amount: amount ?? c.pay.amount, currency: 'INR', method: 'upi', status, email: 'pii@x.test', ...extra };
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

  await t.test('instrument metadata (migration 010): stored for card, never erased by a thinner replay, replaced on a different method', async () => {
    const c = await checkout('instr');
    const card = { method: 'card', card: { network: 'Visa', last4: '4242', type: 'credit', issuer: 'HDFC', number: '4111111111111111', cvv: '123' } };
    // a failed UPI attempt first, then a successful card payment inside the same Razorpay order
    await hook('payment.failed', c, { payId: 'pay_i1', status: 'failed', extra: { method: 'upi', vpa: 'alice@okhdfc', error_code: 'X', error_description: 'x' } });
    let p = await one('SELECT * FROM payments WHERE id=$1', [c.pay.paymentId]);
    assert.equal(p.status, 'FAILED');
    assert.equal(p.upi_handle_masked, 'al***@okhdfc');
    assert.equal(p.card_last4, null);

    assert.equal((await hook('payment.captured', c, { payId: 'pay_i2', status: 'captured', extra: card })).status, 200);
    p = await one('SELECT * FROM payments WHERE id=$1', [c.pay.paymentId]);
    assert.equal(p.status, 'CAPTURED');
    assert.deepEqual(
      [p.method, p.card_network, p.card_last4, p.card_type, p.card_issuer, p.upi_handle_masked],
      ['card', 'VISA', '4242', 'CREDIT', 'HDFC', null], // UPI data replaced, not left stale
    );
    // replay of the same payment without the card object must not erase what is stored
    await hook('order.paid', c, { payId: 'pay_i2', status: 'captured', extra: { method: 'card' } });
    p = await one('SELECT * FROM payments WHERE id=$1', [c.pay.paymentId]);
    assert.deepEqual([p.card_network, p.card_last4], ['VISA', '4242']);
    // no PAN / CVV / full VPA anywhere in what we persisted
    const dump = JSON.stringify(await db.query(
      `SELECT p.*, (SELECT json_agg(t.gateway_response) FROM payment_transactions t WHERE t.payment_id=p.id) tx,
              (SELECT json_agg(e.payload) FROM payment_webhook_events e WHERE e.payment_id=p.id) ev
         FROM payments p WHERE p.id=$1`, [c.pay.paymentId]));
    for (const secret of ['4111111111111111', '"cvv"', 'alice@okhdfc']) assert.ok(!dump.includes(secret), `leaked ${secret}`);
  });

  const INSTR = ['method', 'card_network', 'card_last4', 'card_type', 'card_issuer', 'bank_code', 'wallet_name', 'upi_handle_masked'];
  const instrumentOf = async (paymentId) => {
    const p = await one('SELECT * FROM payments WHERE id=$1', [paymentId]);
    return Object.fromEntries(INSTR.map((k) => [k, p[k]]));
  };

  await t.test('netbanking and wallet metadata are persisted, each in its own column only', async () => {
    const nb = await checkout('nb');
    assert.equal((await hook('payment.captured', nb, { payId: 'pay_nb1', status: 'captured', extra: { method: 'netbanking', bank: 'HDFC' } })).status, 200);
    assert.deepEqual(await instrumentOf(nb.pay.paymentId), {
      method: 'netbanking', card_network: null, card_last4: null, card_type: null, card_issuer: null,
      bank_code: 'HDFC', wallet_name: null, upi_handle_masked: null });
    const w = await checkout('wallet');
    assert.equal((await hook('payment.captured', w, { payId: 'pay_w9', status: 'captured', extra: { method: 'wallet', wallet: 'paytm' } })).status, 200);
    assert.deepEqual(await instrumentOf(w.pay.paymentId), {
      method: 'wallet', card_network: null, card_last4: null, card_type: null, card_issuer: null,
      bank_code: null, wallet_name: 'PAYTM', upi_handle_masked: null });
  });

  await t.test('missing metadata stays null (nothing fabricated) and the payment still settles; historical rows read as null', async () => {
    // historical record: a payment that has never seen any instrument data
    const h = await checkout('hist');
    const before = await one('SELECT * FROM payments WHERE id=$1', [h.pay.paymentId]);
    assert.equal(before.status, 'CREATED');
    assert.ok(INSTR.every((k) => before[k] === null));
    const found = await require('../src/modules/payments/payments.repository').findById(h.pay.paymentId, {});
    assert.equal(found.card_last4, null);
    assert.equal(found.upi_handle_masked, null);
    // card payment whose entity has no card object, and one with unusable values
    assert.equal((await hook('payment.captured', h, { payId: 'pay_h1', status: 'captured', extra: { method: 'card' } })).status, 200);
    const after = await one('SELECT * FROM payments WHERE id=$1', [h.pay.paymentId]);
    assert.equal(after.status, 'CAPTURED');
    assert.deepEqual(await instrumentOf(h.pay.paymentId), {
      method: 'card', card_network: null, card_last4: null, card_type: null, card_issuer: null,
      bank_code: null, wallet_name: null, upi_handle_masked: null });
    const bad = await checkout('badvals');
    await hook('payment.captured', bad, { payId: 'pay_b1', status: 'captured', extra: { method: 'card', card: { last4: '12', type: 'gift' } } });
    const row = await instrumentOf(bad.pay.paymentId);
    assert.equal(row.card_last4, null);
    assert.equal(row.card_type, null);
  });

  await t.test('duplicate delivery keeps metadata stable; payload and logs never contain secrets', async () => {
    const lines = [];
    const grab = (orig) => (...a) => { lines.push(a.map(String).join(' ')); return orig(...a); };
    t.mock.method(console, 'log', grab(console.log.bind(console)));
    t.mock.method(console, 'error', grab(console.error.bind(console)));
    const c = await checkout('dupmeta');
    const extra = { method: 'upi', vpa: 'bob@okicici', card: { number: '4111111111111111', cvv: 'CVV-IN-CARD' },
      cvv: 'CVV-7731', pin: 'PIN-5519', otp: 'OTP-902144', number: '5555555555554444', authentication: { otp: 'OTP-AUTH-4417' } };
    const eventId = `evt_${suffix}_dupmeta`;
    const first = await hook('payment.captured', c, { payId: 'pay_dm1', status: 'captured', eventId, extra });
    const second = await hook('payment.captured', c, { payId: 'pay_dm1', status: 'captured', eventId, extra });
    assert.equal(first.status, 200);
    assert.equal(second.json.data.status, 'DUPLICATE');
    assert.equal((await instrumentOf(c.pay.paymentId)).upi_handle_masked, 'bo***@okicici');
    assert.equal(Number((await one('SELECT COUNT(*) n FROM payment_webhook_events WHERE gateway_event_id=$1', [eventId])).n), 1);
    const stored = JSON.stringify((await one('SELECT payload FROM payment_webhook_events WHERE gateway_event_id=$1', [eventId])).payload);
    const everything = stored + lines.join('\n');
    for (const secret of ['bob@okicici', '4111111111111111', '5555555555554444', 'CVV-IN-CARD', 'CVV-7731', 'PIN-5519', 'OTP-902144', 'OTP-AUTH-4417']) {
      assert.ok(!everything.includes(secret), `leaked ${secret}`);
    }
  });
});
