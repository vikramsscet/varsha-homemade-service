'use strict';

// Offline tests (no database, no network): pricing, duplicate fingerprint, Razorpay client, request validation.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const app = require('../src/app');
const { signToken } = require('../src/utils/jwt');
const { calculateOrder } = require('../src/modules/orders/orders.pricing');
const { fingerprint } = require('../src/modules/orders/orders.service');
const { RazorpayClient } = require('../src/integrations/razorpay/razorpayClient');
const { createOrderSchema } = require('../src/modules/orders/orders.validation');
const { createPaymentOrderSchema } = require('../src/modules/payments/payments.validation');

const base = (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/v1`;
};
const jwt = signToken({ id: crypto.randomUUID(), email: 'offline@example.invalid' });
const post = (url, headers, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

test('pricing: integer paise, tax, shipping, free-shipping threshold', () => {
  const lines = [{ unitPrice: '249.00', quantity: 2 }, { unitPrice: '149.99', quantity: 1 }];
  const plain = calculateOrder(lines, { taxRatePercent: 0, shippingFlatFee: 0, freeShippingThreshold: 0 });
  assert.equal(plain.subtotal, '647.99');
  assert.equal(plain.totalAmount, '647.99');
  assert.equal(plain.totalMinor, 64799);
  assert.deepEqual(plain.itemTotals, ['498.00', '149.99']);

  const full = calculateOrder(lines, { taxRatePercent: 5, shippingFlatFee: 50, freeShippingThreshold: 1000 });
  assert.equal(full.taxAmount, '32.40'); // 5% of 647.99 = 32.3995 -> 32.40
  assert.equal(full.shippingAmount, '50.00');
  assert.equal(full.totalAmount, '730.39');

  const free = calculateOrder(lines, { taxRatePercent: 0, shippingFlatFee: 50, freeShippingThreshold: 600 });
  assert.equal(free.shippingAmount, '0.00');
  // 0.1 + 0.2 style drift cannot happen
  assert.equal(calculateOrder([{ unitPrice: '0.10', quantity: 3 }], { taxRatePercent: 0, shippingFlatFee: 0, freeShippingThreshold: 0 }).totalAmount, '0.30');
});

test('fingerprint ignores item order, changes with price/quantity/address', () => {
  const snap = () => ({
    items: [
      { productId: 'a', quantity: 1, unitPrice: '10.00' },
      { productId: 'b', quantity: 2, unitPrice: '5.50' },
    ],
    totals: { subtotal: '21.00', discountAmount: '0', taxAmount: '0', shippingAmount: '0', totalAmount: '21' },
    customer: { email: 'a@b.c', phone: '+911234567890' },
    shipping: { firstName: 'A', lastName: 'B', phone: '+911234567890', country: 'IN ', addressLine1: 'x', addressLine2: null, city: 'c', state: 's', postalCode: '1' },
  });
  const a = snap();
  const b = snap();
  b.items.reverse();
  b.shipping.country = 'IN';
  b.shipping.addressLine2 = '';
  assert.equal(fingerprint(a), fingerprint(b));
  const c = snap();
  c.items[0].unitPrice = '11.00';
  assert.notEqual(fingerprint(a), fingerprint(c));
  const d = snap();
  d.shipping.city = 'other';
  assert.notEqual(fingerprint(a), fingerprint(d));
});

test('validation strips client-supplied amounts', () => {
  const o = createOrderSchema.validate({ addressId: crypto.randomUUID(), amount: 1, totalAmount: 1 }, { stripUnknown: true });
  assert.equal(o.error, undefined);
  assert.deepEqual(Object.keys(o.value), ['addressId']);
  assert.ok(createOrderSchema.validate({ addressId: 'nope' }).error);
  const p = createPaymentOrderSchema.validate({ orderId: crypto.randomUUID(), amount: 1, currency: 'USD' }, { stripUnknown: true });
  assert.deepEqual(Object.keys(p.value), ['orderId']);
  assert.ok(createPaymentOrderSchema.validate({}).error);
});

test('Razorpay client: Basic auth, body, no secret in result; error mapping', async (t) => {
  const client = new RazorpayClient({ keyId: 'rzp_test_abc123', keySecret: 'sekret-value', baseUrl: 'https://rzp.invalid', timeoutMs: 1000 });
  let seen;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ id: 'order_X1', amount: 12345, currency: 'INR', status: 'created', receipt: 'r1', secretLeak: 'no' }) };
  });
  const out = await client.createOrder({ amount: 12345, currency: 'INR', receipt: 'r1', notes: { a: 'b' } });
  assert.equal(seen.url, 'https://rzp.invalid/v1/orders');
  assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('rzp_test_abc123:sekret-value').toString('base64')}`);
  assert.deepEqual(JSON.parse(seen.init.body), { amount: 12345, currency: 'INR', receipt: 'r1', notes: { a: 'b' } });
  assert.deepEqual(Object.keys(out).sort(), ['amount', 'currency', 'id', 'receipt', 'status']);
  assert.ok(!JSON.stringify(out).includes('sekret-value'));

  globalThis.fetch.mock.mockImplementation(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'secret details' } }) }));
  t.mock.method(console, 'error', () => {});
  await assert.rejects(() => client.createOrder({ amount: 1, currency: 'INR' }), { statusCode: 502, code: 'PAYMENT_GATEWAY_ERROR' });
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('network'); });
  await assert.rejects(() => client.createOrder({ amount: 1, currency: 'INR' }), { code: 'PAYMENT_GATEWAY_UNAVAILABLE' });
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }));
  await assert.rejects(() => client.createOrder({ amount: 1, currency: 'INR' }), { code: 'PAYMENT_GATEWAY_INVALID_RESPONSE' });
});

test('Razorpay client: unconfigured -> 503 without calling the network', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  for (const cfg of [{ keyId: '', keySecret: '' }, { keyId: 'bad', keySecret: 'x' }]) {
    const c = new RazorpayClient({ ...cfg, baseUrl: 'https://rzp.invalid', timeoutMs: 100 });
    await assert.rejects(() => c.createOrder({ amount: 1, currency: 'INR' }), { statusCode: 503, code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test('HTTP: credentials required, cart id is not a credential, bad input rejected before the database', async (t) => {
  const url = base(t);
  for (const path of ['/orders', '/payments/create-order']) {
    let res = await post(url + path, {});
    assert.equal(res.status, 401, path);
    res = await post(url + path, { 'X-Anonymous-Cart-ID': crypto.randomUUID() });
    assert.equal(res.status, 401, `${path} must not accept the anonymous cart id`);
    res = await post(url + path, { Authorization: 'Bearer garbage' });
    assert.equal(res.status, 401);
    res = await post(url + path, { 'X-Guest-Checkout-Session': 'bad' });
    assert.equal((await res.json()).error.code, 'INVALID_GUEST_SESSION');
  }
  // order token is only accepted by payments
  assert.equal((await post(`${url}/orders`, { 'X-Guest-Order-Token': 'a'.repeat(43) })).status, 401);
  const bad = await post(`${url}/payments/create-order`, { 'X-Guest-Order-Token': 'short' }, { orderId: crypto.randomUUID() });
  assert.equal((await bad.json()).error.code, 'INVALID_GUEST_ORDER_TOKEN');

  const auth = { Authorization: `Bearer ${jwt}` };
  let res = await post(`${url}/orders`, { ...auth, 'Idempotency-Key': 'short' }, {});
  assert.equal((await res.json()).error.code, 'INVALID_IDEMPOTENCY_KEY');
  res = await post(`${url}/orders`, auth, { addressId: 'not-a-uuid' });
  assert.equal(res.status, 400);
  res = await post(`${url}/orders`, auth, {});
  assert.equal((await res.json()).error.code, 'ADDRESS_REQUIRED');
  res = await post(`${url}/payments/create-order`, auth, { orderId: 'not-a-uuid' });
  assert.equal(res.status, 400);
  res = await post(`${url}/payments/create-order`, auth, {});
  assert.equal(res.status, 400);
});
