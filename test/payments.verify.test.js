'use strict';

// Offline unit tests for POST /payments/verify: repositories, DB and Razorpay are replaced with an
// in-memory fake, so every scenario (including the state machine and idempotency) runs without I/O.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const db = require('../src/config/database');
const razorpay = require('../src/integrations/razorpay');
const { RazorpayClient } = require('../src/integrations/razorpay/razorpayClient');
const paymentsRepo = require('../src/modules/payments/payments.repository');
const ordersRepo = require('../src/modules/orders/orders.repository');
const cartRepo = require('../src/modules/cart/cart.repository');
const { verifyPayment } = require('../src/modules/payments/payments.verify');
const { verifyPaymentSchema } = require('../src/modules/payments/payments.validation');
const { signToken } = require('../src/utils/jwt');

const USER = crypto.randomUUID();
const RZP_ORDER = 'order_ABC123';
const RZP_PAY = 'pay_XYZ789';
const identity = { type: 'USER', userId: USER, ref: `u:${USER}` };
const input = (over = {}) => ({
  internalPaymentId: 'p1', razorpay_order_id: RZP_ORDER, razorpay_payment_id: RZP_PAY, razorpay_signature: 'a'.repeat(64), ...over,
});

// Builds the fake world and wires the mocks. `gateway` is what Razorpay "returns".
const world = (t, { gateway = {}, payment = {}, order = {}, sigOk = true } = {}) => {
  const w = {
    order: { id: 'o1', order_number: 'VH1', status: 'PENDING_PAYMENT', customer_type: 'USER', user_id: USER, cart_id: 'c1', ...order },
    payment: { id: 'p1', order_id: 'o1', razorpay_order_id: RZP_ORDER, razorpay_payment_id: null, status: 'CREATED', amount: '100.00', currency: 'INR', ...payment },
    cart: 'ACTIVE', ledger: [], audit: [], fetches: 0, otherSuccess: false,
  };
  const gw = { id: RZP_PAY, orderId: RZP_ORDER, status: 'captured', amount: 10000, currency: 'INR', method: 'upi', captured: true, errorCode: null, errorDescription: null, ...gateway };

  t.mock.method(db, 'withTransaction', async (fn) => fn({}));
  t.mock.method(razorpay, 'getKeyId', () => 'rzp_test_x');
  t.mock.method(razorpay, 'verifySignature', () => sigOk);
  t.mock.method(razorpay, 'fetchPayment', async () => { w.fetches += 1; return gw; });
  t.mock.method(paymentsRepo, 'findById', async () => ({ ...w.payment }));
  t.mock.method(paymentsRepo, 'hasSuccessfulPayment', async () => w.otherSuccess);
  t.mock.method(paymentsRepo, 'insertTransaction', async (row, client) => {
    const list = client ? w.ledger : w.audit; // client present = inside the business transaction
    if (list.some((r) => r.idempotencyKey === row.idempotencyKey)) return null;
    list.push(row);
    return { id: 'x' };
  });
  const set = (patch) => { w.payment = { ...w.payment, ...patch }; return { ...w.payment }; };
  t.mock.method(paymentsRepo, 'markCaptured', async (id, d) => (['CREATED', 'PENDING', 'AUTHORIZED', 'FAILED'].includes(w.payment.status) ? set({ status: 'CAPTURED', razorpay_payment_id: d.id }) : null));
  t.mock.method(paymentsRepo, 'markAuthorized', async (id, d) => (['CREATED', 'PENDING', 'FAILED'].includes(w.payment.status) ? set({ status: 'AUTHORIZED', razorpay_payment_id: d.id }) : null));
  t.mock.method(paymentsRepo, 'markPending', async (id, payId) => (w.payment.status === 'CREATED' ? set({ status: 'PENDING', razorpay_payment_id: payId }) : null));
  t.mock.method(paymentsRepo, 'markFailed', async (id, d) => (['CREATED', 'PENDING', 'AUTHORIZED'].includes(w.payment.status) ? set({ status: 'FAILED', razorpay_payment_id: d.id }) : null));
  t.mock.method(ordersRepo, 'findById', async () => ({ ...w.order }));
  t.mock.method(ordersRepo, 'findCart', async () => ({ id: 'c1' }));
  t.mock.method(ordersRepo, 'markPaid', async () => {
    if (w.order.confirmed_at || !['PENDING_PAYMENT', 'PAYMENT_FAILED'].includes(w.order.status)) return null;
    w.order = { ...w.order, status: 'PAID', confirmed_at: new Date() };
    return { ...w.order };
  });
  t.mock.method(ordersRepo, 'markPaymentFailed', async () => {
    if (w.order.status === 'PENDING_PAYMENT') w.order = { ...w.order, status: 'PAYMENT_FAILED' };
  });
  t.mock.method(cartRepo, 'setStatus', async (id, status) => { w.cart = status; });
  t.mock.method(console, 'error', () => {});
  return w;
};

test('success: captured payment marks payment CAPTURED, order PAID, cart COMPLETED, ledger written', async (t) => {
  const w = world(t);
  const r = await verifyPayment(identity, input());
  assert.equal(r.paid, true);
  assert.equal(r.alreadyProcessed, false);
  assert.equal(r.paymentStatus, 'CAPTURED');
  assert.equal(r.orderStatus, 'PAID');
  assert.equal(r.amount, 10000);
  assert.equal(w.cart, 'COMPLETED');
  assert.deepEqual(w.ledger.map((l) => [l.type, l.status, l.idempotencyKey]), [['CAPTURE', 'SUCCESS', `capture:${RZP_PAY}`]]);
  assert.ok(!JSON.stringify(w.ledger).includes('signature'));
});

test('duplicate verification: second call is idempotent, no gateway call, order confirmed once', async (t) => {
  const w = world(t);
  await verifyPayment(identity, input());
  const confirmedAt = w.order.confirmed_at;
  const again = await verifyPayment(identity, input());
  assert.equal(again.alreadyProcessed, true);
  assert.equal(again.paid, true);
  assert.equal(w.fetches, 1, 'second call must not hit Razorpay');
  assert.equal(w.order.confirmed_at, confirmedAt);
  assert.equal(w.ledger.length, 1);
  // concurrent replays are serialised by row locks; that is covered in test/payments.verify.api.test.js
});

test('already processed with a different Razorpay payment id -> 409', async (t) => {
  world(t, { payment: { status: 'CAPTURED', razorpay_payment_id: 'pay_OTHER' }, order: { status: 'PAID' } });
  await assert.rejects(() => verifyPayment(identity, input()), { statusCode: 409, code: 'PAYMENT_ALREADY_PROCESSED' });
});

test('invalid signature: rejected, audited, state untouched, gateway never called', async (t) => {
  const w = world(t, { sigOk: false });
  await assert.rejects(() => verifyPayment(identity, input()), { statusCode: 400, code: 'INVALID_SIGNATURE' });
  assert.equal(w.fetches, 0);
  assert.equal(w.payment.status, 'CREATED');
  assert.equal(w.order.status, 'PENDING_PAYMENT');
  assert.equal(w.audit[0].errorCode, 'INVALID_SIGNATURE');
});

test('incorrect Razorpay order id -> 400 before signature or gateway work', async (t) => {
  const w = world(t);
  await assert.rejects(() => verifyPayment(identity, input({ razorpay_order_id: 'order_OTHER' })), { statusCode: 400, code: 'RAZORPAY_ORDER_MISMATCH' });
  assert.equal(razorpay.verifySignature.mock.callCount(), 0);
  assert.equal(w.fetches, 0);
  assert.equal(w.audit[0].errorCode, 'RAZORPAY_ORDER_MISMATCH');
});

test('unknown payment, and another customer\'s payment, are both 404', async (t) => {
  const w = world(t);
  paymentsRepo.findById.mock.mockImplementation(async () => null);
  await assert.rejects(() => verifyPayment(identity, input()), { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
  paymentsRepo.findById.mock.mockImplementation(async () => ({ ...w.payment }));
  await assert.rejects(() => verifyPayment({ type: 'USER', userId: crypto.randomUUID() }, input()), { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
  assert.equal(w.fetches, 0);
});

test('payment not captured (authorized): 202-style result, order stays unpaid', async (t) => {
  const w = world(t, { gateway: { status: 'authorized', captured: false } });
  const r = await verifyPayment(identity, input());
  assert.equal(r.paid, false);
  assert.equal(r.paymentStatus, 'AUTHORIZED');
  assert.equal(r.orderStatus, 'PENDING_PAYMENT');
  assert.equal(w.cart, 'ACTIVE');
  assert.equal(w.ledger[0].type, 'AUTHORIZATION');
  // later capture verifies successfully from AUTHORIZED
  const w2 = world(t, { payment: { status: 'AUTHORIZED', razorpay_payment_id: RZP_PAY } });
  assert.equal((await verifyPayment(identity, input())).paid, true);
  assert.equal(w2.order.status, 'PAID');
});

test('payment created but not completed -> PENDING, never paid', async (t) => {
  const w = world(t, { gateway: { status: 'created', captured: false } });
  const r = await verifyPayment(identity, input());
  assert.equal(r.paymentStatus, 'PENDING');
  assert.equal(r.paid, false);
  assert.equal(w.order.status, 'PENDING_PAYMENT');
});

test('failed payment: payment FAILED, order PAYMENT_FAILED (kept), 402, idempotent on repeat', async (t) => {
  const w = world(t, { gateway: { status: 'failed', captured: false, errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'Card declined' } });
  await assert.rejects(() => verifyPayment(identity, input()), { statusCode: 402, code: 'PAYMENT_FAILED' });
  assert.equal(w.payment.status, 'FAILED');
  assert.equal(w.order.status, 'PAYMENT_FAILED');
  assert.equal(w.cart, 'ACTIVE');
  await assert.rejects(() => verifyPayment(identity, input()), { code: 'PAYMENT_FAILED' });
  assert.equal(w.ledger.length, 1, 'repeated failure is not duplicated in the ledger');
});

test('retry inside the same Razorpay order: FAILED payment can still be captured by a later successful attempt', async (t) => {
  const w = world(t, { payment: { status: 'FAILED', razorpay_payment_id: 'pay_FIRST' }, order: { status: 'PAYMENT_FAILED' } });
  const r = await verifyPayment(identity, input());
  assert.equal(r.paid, true);
  assert.equal(w.order.status, 'PAID');
});

test('gateway data that disagrees with our records is never accepted', async (t) => {
  for (const gateway of [{ amount: 100 }, { currency: 'USD' }, { orderId: 'order_ELSE' }]) {
    const w = world(t, { gateway });
    await assert.rejects(() => verifyPayment(identity, input()), { statusCode: 409, code: 'PAYMENT_MISMATCH' });
    assert.equal(w.order.status, 'PENDING_PAYMENT');
  }
});

test('captured money for an order that is already paid / not payable is flagged, never double-confirmed', async (t) => {
  const paid = world(t, { order: { status: 'PAID', confirmed_at: new Date() } });
  paid.otherSuccess = true;
  await assert.rejects(() => verifyPayment(identity, input()), { code: 'ORDER_ALREADY_PAID' });
  assert.equal(paid.ledger[0].errorCode, 'ORDER_ALREADY_PAID');
  assert.equal(paid.payment.status, 'CREATED');

  const cancelled = world(t, { order: { status: 'CANCELLED' } });
  await assert.rejects(() => verifyPayment(identity, input()), { code: 'ORDER_NOT_PAYABLE' });
  assert.equal(cancelled.ledger[0].errorCode, 'ORDER_NOT_PAYABLE');
});

test('refunded at the gateway -> 409, nothing changes', async (t) => {
  const w = world(t, { gateway: { status: 'refunded' } });
  await assert.rejects(() => verifyPayment(identity, input()), { code: 'PAYMENT_REFUNDED' });
  assert.equal(w.order.status, 'PENDING_PAYMENT');
});

test('Razorpay client: signature = HMAC-SHA256(order|payment, secret), constant-time; fetchPayment whitelists fields', async (t) => {
  const c = new RazorpayClient({ keyId: 'rzp_test_abc', keySecret: 'topsecret', baseUrl: 'https://rzp.invalid', timeoutMs: 500 });
  const good = crypto.createHmac('sha256', 'topsecret').update(`${RZP_ORDER}|${RZP_PAY}`).digest('hex');
  assert.equal(c.verifySignature({ razorpayOrderId: RZP_ORDER, razorpayPaymentId: RZP_PAY, signature: good }), true);
  assert.equal(c.verifySignature({ razorpayOrderId: RZP_ORDER, razorpayPaymentId: RZP_PAY, signature: good.replace(/.$/, good.endsWith('0') ? '1' : '0') }), false);
  assert.equal(c.verifySignature({ razorpayOrderId: 'order_X', razorpayPaymentId: RZP_PAY, signature: good }), false);
  assert.equal(c.verifySignature({ razorpayOrderId: RZP_ORDER, razorpayPaymentId: RZP_PAY, signature: 'short' }), false);
  assert.equal(c.verifySignature({ razorpayOrderId: RZP_ORDER, razorpayPaymentId: RZP_PAY, signature: undefined }), false);

  let url;
  t.mock.method(globalThis, 'fetch', async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ id: RZP_PAY, order_id: RZP_ORDER, status: 'captured', amount: 10000, currency: 'INR', method: 'card', captured: true, email: 'pii@x', contact: '+91', card: { last4: '1111' } }) };
  });
  const d = await c.fetchPayment(RZP_PAY);
  assert.equal(url, `https://rzp.invalid/v1/payments/${RZP_PAY}`);
  assert.equal(d.status, 'captured');
  assert.ok(!('email' in d) && !('card' in d) && !('contact' in d));
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ id: 'pay_other', status: 'captured', amount: 1 }) }));
  await assert.rejects(() => c.fetchPayment(RZP_PAY), { code: 'PAYMENT_GATEWAY_INVALID_RESPONSE' });
});

test('request validation: strict formats, client-claimed success fields stripped', () => {
  const ok = { internalPaymentId: crypto.randomUUID(), razorpay_order_id: RZP_ORDER, razorpay_payment_id: RZP_PAY, razorpay_signature: 'f'.repeat(64) };
  const v = verifyPaymentSchema.validate({ ...ok, status: 'captured', paid: true }, { stripUnknown: true });
  assert.equal(v.error, undefined);
  assert.deepEqual(Object.keys(v.value).sort(), Object.keys(ok).sort());
  for (const bad of [{ internalPaymentId: 'x' }, { razorpay_order_id: 'pay_1' }, { razorpay_payment_id: 'order_1' }, { razorpay_signature: 'zz' }, { razorpay_signature: undefined }]) {
    assert.ok(verifyPaymentSchema.validate({ ...ok, ...bad }).error, JSON.stringify(bad));
  }
});

test('HTTP: verify needs credentials and valid body (before any database work)', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/v1/payments/verify`;
  const body = JSON.stringify({ internalPaymentId: crypto.randomUUID(), razorpay_order_id: RZP_ORDER, razorpay_payment_id: RZP_PAY, razorpay_signature: 'a'.repeat(64) });
  const post = (headers, b = body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: b });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ 'X-Anonymous-Cart-ID': crypto.randomUUID() })).status, 401);
  assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401);
  const jwt = signToken({ id: crypto.randomUUID(), email: 'v@example.invalid' });
  const bad = await post({ Authorization: `Bearer ${jwt}` }, JSON.stringify({ razorpay_order_id: 'x' }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');
});
