'use strict';

// Offline tests for POST /payments/webhook. Repositories, DB and the signature primitive are replaced with
// an in-memory fake; the real settlement state machine, event handling and HTTP/raw-body path are exercised.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const db = require('../src/config/database');
const razorpay = require('../src/integrations/razorpay');
const { RazorpayClient } = require('../src/integrations/razorpay/razorpayClient');
const paymentsRepo = require('../src/modules/payments/payments.repository');
const eventsRepo = require('../src/modules/payments/webhookEvents.repository');
const ordersRepo = require('../src/modules/orders/orders.repository');
const cartRepo = require('../src/modules/cart/cart.repository');
const { handleWebhook, redact } = require('../src/modules/payments/payments.webhook');
const { verifyPayment } = require('../src/modules/payments/payments.verify');

const SECRET = 'whsec-test-only';
const RZP_ORDER = 'order_ABC123';
const PAY = 'pay_AAA111';
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

const payloadFor = (type, { id = PAY, amount = 10000, currency = 'INR', status, order = RZP_ORDER, extra = {} } = {}) => {
  const payment = { id, order_id: order, amount, currency, method: 'upi', status, email: 'pii@x.test', contact: '+911234567890', ...extra };
  const body = { event: type, payload: { payment: { entity: payment } } };
  if (type === 'order.paid') body.payload.order = { entity: { id: order, status: 'paid', amount_paid: amount } };
  return body;
};
// A delivery as Razorpay sends it: raw bytes + signature + event id.
const delivery = (type, opts = {}, eventId = `evt_${crypto.randomBytes(5).toString('hex')}`) => {
  const raw = Buffer.from(JSON.stringify(payloadFor(type, opts)));
  return { rawBody: raw, signature: sign(raw), eventIdHeader: eventId };
};

const world = (t, { payment = {}, order = {} } = {}) => {
  const w = {
    order: { id: 'o1', order_number: 'VH1', status: 'PENDING_PAYMENT', customer_type: 'USER', user_id: 'u1', cart_id: 'c1', ...order },
    payment: { id: 'p1', order_id: 'o1', razorpay_order_id: RZP_ORDER, razorpay_payment_id: null, status: 'CREATED', amount: '100.00', currency: 'INR', ...payment },
    cart: 'ACTIVE', ledger: [], events: new Map(), seq: 0, failNextLookup: false, confirmations: 0,
  };
  const client = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'k', webhookSecret: SECRET, baseUrl: 'x', timeoutMs: 1 });
  t.mock.method(razorpay, 'verifyWebhookSignature', (raw, sig) => client.verifyWebhookSignature(raw, sig));
  t.mock.method(razorpay, 'getKeyId', () => 'rzp_test_x');
  t.mock.method(razorpay, 'verifySignature', () => true);
  t.mock.method(razorpay, 'fetchPayment', async (id) => ({ id, orderId: RZP_ORDER, status: 'captured', amount: 10000, currency: 'INR', method: 'upi', captured: true }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});

  t.mock.method(db, 'withTransaction', async (fn) => fn({}));
  // events table
  t.mock.method(eventsRepo, 'insert', async (e) => {
    if (w.events.has(e.eventId)) return null;
    const row = { id: `ev${++w.seq}`, eventId: e.eventId, event_type: e.eventType, processing_status: 'RECEIVED', attempts: 0, payload: e.payload, last_error: null };
    w.events.set(e.eventId, row);
    return { ...row };
  });
  t.mock.method(eventsRepo, 'findByEventId', async (id) => ({ ...w.events.get(id) }));
  const byId = (id) => [...w.events.values()].find((r) => r.id === id);
  t.mock.method(eventsRepo, 'claim', async (id) => {
    const r = byId(id);
    if (!['RECEIVED', 'FAILED'].includes(r.processing_status)) return null;
    r.processing_status = 'PROCESSING'; r.attempts += 1;
    return { ...r };
  });
  t.mock.method(eventsRepo, 'finish', async (id, status, reason) => { const r = byId(id); r.processing_status = status; r.last_error = reason || null; });
  t.mock.method(eventsRepo, 'fail', async (id, msg) => { const r = byId(id); r.processing_status = 'FAILED'; r.last_error = msg; });
  // payments / orders
  const set = (patch) => { w.payment = { ...w.payment, ...patch }; return { ...w.payment }; };
  t.mock.method(paymentsRepo, 'findByRazorpayOrderId', async (id) => {
    if (w.failNextLookup) { w.failNextLookup = false; throw new Error('connection reset'); }
    return id === RZP_ORDER ? { ...w.payment } : null;
  });
  t.mock.method(paymentsRepo, 'findById', async () => ({ ...w.payment }));
  t.mock.method(paymentsRepo, 'hasSuccessfulPayment', async () => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(w.payment.status));
  t.mock.method(paymentsRepo, 'insertTransaction', async (row) => {
    if (w.ledger.some((r) => r.idempotencyKey === row.idempotencyKey)) return null;
    w.ledger.push(row); return { id: 'x' };
  });
  t.mock.method(paymentsRepo, 'markCaptured', async (id, d) => (['CREATED', 'PENDING', 'AUTHORIZED', 'FAILED'].includes(w.payment.status) ? set({ status: 'CAPTURED', razorpay_payment_id: d.id }) : null));
  t.mock.method(paymentsRepo, 'markAuthorized', async (id, d) => (['CREATED', 'PENDING', 'FAILED'].includes(w.payment.status) ? set({ status: 'AUTHORIZED', razorpay_payment_id: d.id }) : null));
  t.mock.method(paymentsRepo, 'markPending', async (id, p) => (w.payment.status === 'CREATED' ? set({ status: 'PENDING', razorpay_payment_id: p }) : null));
  t.mock.method(paymentsRepo, 'markFailed', async (id, d) => (['CREATED', 'PENDING', 'AUTHORIZED'].includes(w.payment.status) ? set({ status: 'FAILED', razorpay_payment_id: d.id }) : null));
  t.mock.method(ordersRepo, 'findById', async () => ({ ...w.order }));
  t.mock.method(ordersRepo, 'findCart', async () => ({ id: 'c1' }));
  t.mock.method(ordersRepo, 'markPaid', async () => {
    if (w.order.confirmed_at || !['PENDING_PAYMENT', 'PAYMENT_FAILED'].includes(w.order.status)) return null;
    w.order = { ...w.order, status: 'PAID', confirmed_at: new Date() }; w.confirmations += 1;
    return { ...w.order };
  });
  t.mock.method(ordersRepo, 'markPaymentFailed', async () => { if (w.order.status === 'PENDING_PAYMENT') w.order = { ...w.order, status: 'PAYMENT_FAILED' }; });
  t.mock.method(cartRepo, 'setStatus', async (id, s) => { w.cart = s; });
  w.event = (id) => w.events.get(id);
  return w;
};

test('invalid or missing signature is rejected with 400 and nothing is stored or changed', async (t) => {
  const w = world(t);
  const d = delivery('payment.captured', { status: 'captured' });
  for (const signature of ['a'.repeat(64), undefined, 'short', sign(Buffer.from('other'))]) {
    await assert.rejects(() => handleWebhook({ ...d, signature }), { statusCode: 400, code: 'INVALID_WEBHOOK_SIGNATURE' });
  }
  // tampered body with the original signature
  await assert.rejects(() => handleWebhook({ ...d, rawBody: Buffer.from(d.rawBody.toString().replace('10000', '1')) }), { code: 'INVALID_WEBHOOK_SIGNATURE' });
  assert.equal(w.events.size, 0);
  assert.equal(w.order.status, 'PENDING_PAYMENT');
});

test('webhook secret not configured -> 503 so Razorpay retries (event not dropped)', async (t) => {
  const c = new RazorpayClient({ keyId: 'rzp_test_x', keySecret: 'k', webhookSecret: '', baseUrl: 'x', timeoutMs: 1 });
  assert.throws(() => c.verifyWebhookSignature(Buffer.from('{}'), 'a'.repeat(64)), { statusCode: 503, code: 'PAYMENT_WEBHOOK_NOT_CONFIGURED' });
});

test('payment.captured: payment CAPTURED, order PAID once, cart COMPLETED, ledger linked to the event', async (t) => {
  const w = world(t);
  const d = delivery('payment.captured', { status: 'captured' });
  const r = await handleWebhook(d);
  assert.deepEqual([r.status, r.body.status], [200, 'PROCESSED']);
  assert.equal(w.payment.status, 'CAPTURED');
  assert.equal(w.order.status, 'PAID');
  assert.equal(w.cart, 'COMPLETED');
  assert.equal(w.ledger.length, 1);
  assert.equal(w.ledger[0].source, 'WEBHOOK');
  assert.equal(w.ledger[0].webhookEventId, w.event(d.eventIdHeader).id);
  assert.equal(w.event(d.eventIdHeader).processing_status, 'PROCESSED');
});

test('duplicate delivery of the same event id -> 200 DUPLICATE, no second confirmation', async (t) => {
  const w = world(t);
  const d = delivery('payment.captured', { status: 'captured' });
  await handleWebhook(d);
  const again = await handleWebhook(d);
  assert.equal(again.body.status, 'DUPLICATE');
  assert.equal(w.confirmations, 1);
  assert.equal(w.ledger.length, 1);
  assert.equal(w.event(d.eventIdHeader).attempts, 1);
});

test('same fact under different event ids (payment.captured + order.paid) confirms exactly once', async (t) => {
  const w = world(t);
  const a = await handleWebhook(delivery('order.paid', { status: 'captured' }));
  const b = await handleWebhook(delivery('payment.captured', { status: 'captured' }));
  assert.equal(a.body.status, 'PROCESSED');
  assert.equal(b.body.status, 'IGNORED');
  assert.equal(w.confirmations, 1);
  assert.equal(w.ledger.filter((l) => l.type === 'CAPTURE').length, 1);
  assert.equal([...w.events.values()].find((e) => e.event_type === 'payment.captured').last_error, 'DUPLICATE_EVENT');
});

test('out of order: authorized after captured never downgrades; failed of an older attempt never undoes a capture', async (t) => {
  const w = world(t);
  await handleWebhook(delivery('payment.captured', { status: 'captured' }));
  const late = await handleWebhook(delivery('payment.authorized', { status: 'authorized' }));
  assert.equal(late.body.status, 'IGNORED');
  const olderFail = await handleWebhook(delivery('payment.failed', { id: 'pay_OLD', status: 'failed', extra: { error_code: 'BAD_REQUEST_ERROR' } }));
  assert.equal(olderFail.body.status, 'IGNORED');
  assert.equal(w.payment.status, 'CAPTURED');
  assert.equal(w.order.status, 'PAID');
  assert.equal(w.payment.razorpay_payment_id, PAY);
});

test('out of order: captured arriving before authorized works; authorized then captured also works', async (t) => {
  const a = world(t);
  await handleWebhook(delivery('payment.authorized', { status: 'authorized' }));
  assert.equal(a.payment.status, 'AUTHORIZED');
  assert.equal(a.order.status, 'PENDING_PAYMENT');
  await handleWebhook(delivery('payment.captured', { status: 'captured' }));
  assert.equal(a.payment.status, 'CAPTURED');
  assert.equal(a.order.status, 'PAID');
});

test('failed attempt then successful retry inside the same Razorpay order -> PAID', async (t) => {
  const w = world(t);
  const f = await handleWebhook(delivery('payment.failed', { id: 'pay_1', status: 'failed', extra: { error_code: 'BAD_REQUEST_ERROR', error_description: 'declined' } }));
  assert.equal(f.body.status, 'PROCESSED');
  assert.equal(w.payment.status, 'FAILED');
  assert.equal(w.order.status, 'PAYMENT_FAILED');
  await handleWebhook(delivery('payment.captured', { id: 'pay_2', status: 'captured' }));
  assert.equal(w.order.status, 'PAID');
  assert.equal(w.payment.razorpay_payment_id, 'pay_2');
});

test('failed event of an older attempt does not fail a newer authorized payment', async (t) => {
  const w = world(t, { payment: { status: 'AUTHORIZED', razorpay_payment_id: 'pay_NEW' } });
  const r = await handleWebhook(delivery('payment.failed', { id: 'pay_OLD', status: 'failed' }));
  assert.equal(r.body.status, 'IGNORED');
  assert.equal(w.payment.status, 'AUTHORIZED');
});

test('verify (frontend) and webhook converge: second path is a no-op, one ledger row, one confirmation', async (t) => {
  const w = world(t);
  const identity = { type: 'USER', userId: 'u1' };
  const v = await verifyPayment(identity, { internalPaymentId: 'p1', razorpay_order_id: RZP_ORDER, razorpay_payment_id: PAY, razorpay_signature: 'a'.repeat(64) });
  assert.equal(v.paid, true);
  const hook = await handleWebhook(delivery('payment.captured', { status: 'captured' }));
  assert.equal(hook.body.status, 'IGNORED');
  assert.equal(w.confirmations, 1);
  assert.equal(w.ledger.filter((l) => l.type === 'CAPTURE').length, 1);
  // and the reverse: webhook first, then the browser callback
  const w2 = world(t);
  await handleWebhook(delivery('payment.captured', { status: 'captured' }));
  const v2 = await verifyPayment(identity, { internalPaymentId: 'p1', razorpay_order_id: RZP_ORDER, razorpay_payment_id: PAY, razorpay_signature: 'a'.repeat(64) });
  assert.equal(v2.alreadyProcessed, true);
  assert.equal(w2.confirmations, 1);
});

test('a second captured payment for an already-settled order is flagged for refund, not applied', async (t) => {
  const w = world(t, { payment: { status: 'CAPTURED', razorpay_payment_id: PAY }, order: { status: 'PAID', confirmed_at: new Date() } });
  const r = await handleWebhook(delivery('payment.captured', { id: 'pay_SECOND', status: 'captured' }));
  assert.equal(r.body.status, 'IGNORED');
  assert.equal(w.ledger[0].errorCode, 'DUPLICATE_CAPTURE');
  assert.equal(w.payment.razorpay_payment_id, PAY);
});

test('unknown order, unsupported event, malformed event, amount mismatch: stored, ignored, 200, state untouched', async (t) => {
  const w = world(t);
  const unknown = await handleWebhook(delivery('payment.captured', { order: 'order_FOREIGN', status: 'captured' }));
  assert.equal(w.event(unknown.eventIdHeader || [...w.events.keys()][0]).last_error, 'UNKNOWN_PAYMENT');
  const refund = Buffer.from(JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: PAY } } } }));
  const u = await handleWebhook({ rawBody: refund, signature: sign(refund), eventIdHeader: 'evt_refund' });
  assert.equal(u.body.status, 'IGNORED');
  assert.equal(w.event('evt_refund').last_error, 'UNSUPPORTED_EVENT');
  const bad = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }));
  assert.equal((await handleWebhook({ rawBody: bad, signature: sign(bad), eventIdHeader: 'evt_bad' })).body.status, 'IGNORED');
  for (const opts of [{ amount: 500 }, { currency: 'USD' }]) {
    const r = await handleWebhook(delivery('payment.captured', { status: 'captured', ...opts }));
    assert.equal(r.body.status, 'IGNORED');
  }
  assert.equal(w.order.status, 'PENDING_PAYMENT');
  assert.equal(w.payment.status, 'CREATED');
});

test('transient failure: 500, event kept as FAILED, redelivery succeeds and processes exactly once', async (t) => {
  const w = world(t);
  w.failNextLookup = true;
  const d = delivery('payment.captured', { status: 'captured' });
  await assert.rejects(() => handleWebhook(d), { statusCode: 500, code: 'WEBHOOK_PROCESSING_FAILED' });
  assert.equal(w.event(d.eventIdHeader).processing_status, 'FAILED');
  assert.equal(w.order.status, 'PENDING_PAYMENT');
  const retry = await handleWebhook(d);
  assert.equal(retry.body.status, 'PROCESSED');
  assert.equal(w.event(d.eventIdHeader).attempts, 2);
  assert.equal(w.confirmations, 1);
});

test('event being processed by another delivery -> 409 so Razorpay retries later', async (t) => {
  const w = world(t);
  const d = delivery('payment.captured', { status: 'captured' });
  await handleWebhook({ ...d }); // processed
  w.event(d.eventIdHeader).processing_status = 'PROCESSING';
  const r = await handleWebhook(d);
  assert.deepEqual([r.status, r.body.status], [409, 'IN_PROGRESS']);
});

test('after too many failed attempts the event is abandoned with 200 (no endless retry storm)', async (t) => {
  const w = world(t);
  const d = delivery('payment.captured', { status: 'captured' });
  w.failNextLookup = true;
  await assert.rejects(() => handleWebhook(d));
  w.event(d.eventIdHeader).attempts = 10;
  const r = await handleWebhook(d);
  assert.equal(r.body.status, 'ABANDONED');
  assert.equal(w.order.status, 'PENDING_PAYMENT');
});

test('stored payload is stripped of customer PII; no signature/secret is persisted', async (t) => {
  const w = world(t);
  const d = delivery('payment.captured', { status: 'captured', extra: { card: { last4: '1111' }, vpa: 'a@upi', acquirer_data: { rrn: '1' } } });
  await handleWebhook(d);
  const stored = JSON.stringify(w.event(d.eventIdHeader).payload);
  for (const leak of ['pii@x.test', '+911234567890', '1111', 'a@upi', SECRET, d.signature]) assert.ok(!stored.includes(leak), leak);
  assert.ok(stored.includes(PAY) && stored.includes('10000'));
  assert.deepEqual(redact({ a: [{ email: 'x', keep: 1 }] }), { a: [{ keep: 1 }] });
});

test('HTTP: raw bytes are what is signed (odd whitespace/unicode OK, any change rejected); no auth headers needed', async (t) => {
  const w = world(t);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/v1/payments/webhook`;
  const raw = `{ "event" : "payment.captured",\n  "payload":{"payment":{"entity":{"id":"${PAY}","order_id":"${RZP_ORDER}","amount":10000,"currency":"INR","note":"₹ ünï"}}}  }`;
  const post = (body, sig, extra = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': 'evt_http1', ...extra }, body });

  let res = await post(raw, sign(Buffer.from(raw)));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, 'PROCESSED');
  assert.equal(w.order.status, 'PAID');

  res = await post(raw, sign(Buffer.from(raw)));
  assert.equal((await res.json()).data.status, 'DUPLICATE');
  res = await post(raw.replace('10000', '10001'), sign(Buffer.from(raw)), { 'X-Razorpay-Event-Id': 'evt_http2' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_WEBHOOK_SIGNATURE');
  res = await post('', sign(Buffer.alloc(0)));
  assert.equal(res.status, 400);
  res = await post('not json', sign(Buffer.from('not json')), { 'X-Razorpay-Event-Id': 'evt_http3' });
  assert.equal((await res.json()).error.code, 'INVALID_WEBHOOK_PAYLOAD');
  // regular JSON routes are unaffected by the raw parser
  const other = await fetch(url.replace('/webhook', '/create-order'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(other.status, 401);
});
