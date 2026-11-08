'use strict';

// Offline tests (no database, no network): POST /api/v1/shipping/serviceability.
// Cart service and product package info are stubbed; Shiprocket HTTP calls are intercepted via fetch.
process.env.NODE_ENV = 'test';
process.env.SHIPROCKET_BASE_URL = 'https://shiprocket.test/v1/external';
process.env.SHIPROCKET_EMAIL = 'ops@example.com';
process.env.SHIPROCKET_PASSWORD = 'super-secret-password';
process.env.SHIPROCKET_PICKUP_PINCODE = '411057';
process.env.SHIPPING_PACKAGING_WEIGHT_GRAMS = '100';
const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { cartService } = require('../src/modules/cart');
const { productServiceClient } = require('../src/integrations/product');
const shiprocketIntegration = require('../src/integrations/shiprocket');
const { buildPackage } = require('../src/modules/shipping/shipping.package');

const ANON = '5b0e6d0e-7f0b-4b44-9d0a-1b2c3d4e5f60';
const P1 = '11111111-1111-4111-8111-111111111111'; // 550g 10x10x12
const P2 = '22222222-2222-4222-8222-222222222222'; // 1050g 20x15x10
const realFetch = globalThis.fetch; // captured before any stubbing
const TOKEN = 'tok_abc123';

// Package data per product (the real client's provider depends on .env, so always stub it).
const PACKAGES = {
  [P1]: { weightGrams: 550, lengthCm: 10, breadthCm: 10, heightCm: 12 },
  [P2]: { weightGrams: 1050, lengthCm: 20, breadthCm: 15, heightCm: 10 },
};

const item = (productId, quantity) => ({ productId, quantity });
const cartWith = (...items) => ({ items, subtotal: 1000 });

// Boots the app, stubs cart + fetch. `shiprocket(url, init)` answers Shiprocket calls.
const setup = (t, { cart = cartWith(item(P1, 1)), shiprocket, packages = PACKAGES } = {}) => {
  shiprocketIntegration._resetForTests();
  const server = app.listen(0);
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shiprocketCalls = [];
  t.mock.method(productServiceClient, 'getPackageInfo', async (id) => packages[id] || null);
  t.mock.method(cartService, 'getCurrentCart', async () => cart);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith(origin)) return realFetch(url, init);
    shiprocketCalls.push({ url: String(url), init });
    return shiprocket(String(url), init);
  });
  const post = (body) =>
    realFetch(`${origin}/api/v1/shipping/serviceability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anonymous-Cart-ID': ANON },
      body: JSON.stringify(body),
    });
  return { post, shiprocketCalls, origin };
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const okLogin = () => json(200, { token: TOKEN });
const couriers = (n) => json(200, { status: 200, data: { available_courier_companies: Array.from({ length: n }, (_, i) => ({ courier_company_id: i, rate: 50 })) } });
const router = (serviceability) => (url) => (url.includes('/auth/login') ? okLogin() : serviceability(url));
const quiet = (t) => t.mock.method(console, 'error', () => {});

test('serviceable PIN code returns the normalized response and maps every Shiprocket parameter', async (t) => {
  const { post, shiprocketCalls } = setup(t, { shiprocket: router(() => couriers(3)) });
  const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    data: {
      serviceable: true,
      deliveryPincode: '560001',
      pickupPincode: '411057',
      message: 'Delivery is available at your location',
    },
  });

  const call = shiprocketCalls.find((c) => c.url.includes('/courier/serviceability/'));
  const q = new URL(call.url).searchParams;
  assert.equal(q.get('pickup_postcode'), '411057');
  assert.equal(q.get('delivery_postcode'), '560001');
  assert.equal(q.get('cod'), '0');
  assert.equal(q.get('weight'), '0.65'); // 550g + 100g packaging
  assert.equal(q.get('length'), '10');
  assert.equal(q.get('breadth'), '10');
  assert.equal(q.get('height'), '12');
  assert.equal(q.get('declared_value'), '1000');
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.method, undefined); // GET
});

test('COD maps to cod=1', async (t) => {
  const { post, shiprocketCalls } = setup(t, { shiprocket: router(() => couriers(1)) });
  assert.equal((await post({ deliveryPincode: '560001', paymentMethod: 'COD' })).status, 200);
  const call = shiprocketCalls.find((c) => c.url.includes('/courier/serviceability/'));
  assert.equal(new URL(call.url).searchParams.get('cod'), '1');
});

test('non-serviceable PIN code (empty courier list and Shiprocket 404) returns serviceable=false', async (t) => {
  for (const answer of [() => couriers(0), () => json(404, { status: 404, message: 'No courier serviceability' })]) {
    const { post } = setup(t, { shiprocket: router(answer) });
    const res = await post({ deliveryPincode: '999999', paymentMethod: 'PREPAID' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      success: true,
      data: {
        serviceable: false,
        deliveryPincode: '999999',
        message: 'Currently, delivery is unavailable at this PIN code',
      },
    });
  }
});

test('invalid PIN codes are rejected with 400 before any outbound call', async (t) => {
  const { post, shiprocketCalls } = setup(t, { shiprocket: router(() => couriers(1)) });
  for (const deliveryPincode of ['41105', '4110577', '41105a', '', ' 411057', 411057, null]) {
    const res = await post({ deliveryPincode, paymentMethod: 'PREPAID' });
    assert.equal(res.status, 400, JSON.stringify(deliveryPincode));
    assert.equal((await res.json()).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await post({ paymentMethod: 'PREPAID' })).status, 400);
  assert.equal(shiprocketCalls.length, 0);
});

test('missing or invalid payment method is rejected with 400', async (t) => {
  const { post, shiprocketCalls } = setup(t, { shiprocket: router(() => couriers(1)) });
  for (const body of [
    { deliveryPincode: '411057' },
    { deliveryPincode: '411057', paymentMethod: 'CARD' },
    { deliveryPincode: '411057', paymentMethod: 'prepaid' },
    { deliveryPincode: '411057', paymentMethod: '' },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error.details.some((d) => d.field === 'paymentMethod'));
  }
  assert.equal(shiprocketCalls.length, 0);
});

test('client-supplied weight/dimensions are ignored', async (t) => {
  const { post, shiprocketCalls } = setup(t, { shiprocket: router(() => couriers(1)) });
  await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID', weight: 99, length: 99, height: 99 });
  const q = new URL(shiprocketCalls.find((c) => c.url.includes('/courier/')).url).searchParams;
  assert.equal(q.get('weight'), '0.65');
  assert.equal(q.get('height'), '12');
});

test('missing product weight returns 422 and never calls Shiprocket', async (t) => {
  const { post, shiprocketCalls } = setup(t, {
    packages: { [P1]: { ...PACKAGES[P1], weightGrams: null } },
    shiprocket: router(() => couriers(1)),
  });
  const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'PRODUCT_PACKAGE_INFO_MISSING');
  assert.equal(shiprocketCalls.length, 0);
});

test('multiple products: weights summed with packaging, boxes stacked', async (t) => {
  const { post, shiprocketCalls } = setup(t, {
    cart: cartWith(item(P1, 2), item(P2, 1)),
    shiprocket: router(() => couriers(2)),
  });
  assert.equal((await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' })).status, 200);
  const q = new URL(shiprocketCalls.find((c) => c.url.includes('/courier/')).url).searchParams;
  assert.equal(q.get('weight'), '2.25'); // 2*550 + 1050 + 100 = 2250g
  assert.equal(q.get('length'), '20'); // largest footprint
  assert.equal(q.get('breadth'), '15');
  assert.equal(q.get('height'), '34'); // 2*12 + 10
});

test('empty cart returns 422 CART_EMPTY', async (t) => {
  const { post } = setup(t, { cart: cartWith(), shiprocket: router(() => couriers(1)) });
  const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'CART_EMPTY');
});

test('requires a cart identity', async (t) => {
  const { origin } = setup(t, { shiprocket: router(() => couriers(1)) });
  const res = await fetch(`${origin}/api/v1/shipping/serviceability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryPincode: '560001', paymentMethod: 'PREPAID' }),
  });
  assert.equal(res.status, 401);
});

test('Shiprocket authentication failure returns 502 without leaking credentials', async (t) => {
  quiet(t);
  const { post } = setup(t, { shiprocket: () => json(403, { message: 'Invalid email or password' }) });
  const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.match(text, /SHIPPING_PROVIDER_AUTH_FAILED/);
  assert.doesNotMatch(text, /super-secret-password|ops@example\.com|Invalid email/);
});

test('an expired token (401) is refreshed once and the call retried', async (t) => {
  let logins = 0;
  const { post } = setup(t, {
    shiprocket: (url, init) => {
      if (url.includes('/auth/login')) return json(200, { token: `tok_${++logins}` });
      return init.headers.Authorization === 'Bearer tok_1' ? json(401, { message: 'Unauthorized' }) : couriers(1);
    },
  });
  const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  assert.equal(res.status, 200);
  assert.equal(logins, 2);
});

test('the token is cached across requests', async (t) => {
  let logins = 0;
  const { post } = setup(t, {
    shiprocket: (url) => (url.includes('/auth/login') ? (logins++, okLogin()) : couriers(1)),
  });
  await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  await post({ deliveryPincode: '560002', paymentMethod: 'COD' });
  assert.equal(logins, 1);
});

test('Shiprocket timeout returns 504', async (t) => {
  quiet(t);
  const { post } = setup(t, {
    shiprocket: router(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }),
  });
  const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, 'SHIPPING_PROVIDER_TIMEOUT');
});

test('Shiprocket API failure (5xx, garbage body, network) returns 502 and no raw payload', async (t) => {
  quiet(t);
  const cases = [
    [() => json(500, { message: 'boom', internal: 'secret-detail' }), 'SHIPPING_PROVIDER_ERROR'],
    [() => json(200, { unexpected: true }), 'SHIPPING_PROVIDER_INVALID_RESPONSE'],
    [() => { throw new TypeError('fetch failed'); }, 'SHIPPING_PROVIDER_UNAVAILABLE'],
  ];
  for (const [answer, code] of cases) {
    const { post } = setup(t, { shiprocket: router(answer) });
    const res = await post({ deliveryPincode: '560001', paymentMethod: 'PREPAID' });
    assert.equal(res.status, 502);
    const text = JSON.stringify(await res.json());
    assert.match(text, new RegExp(code));
    assert.doesNotMatch(text, /secret-detail|boom/);
  }
});

test('buildPackage rejects zero/negative values and is greater than zero otherwise', () => {
  const ok = { weightGrams: 100, lengthCm: 1, breadthCm: 1, heightCm: 1 };
  assert.throws(() => buildPackage([{ productId: 'x', quantity: 1, info: { ...ok, heightCm: 0 } }]), { code: 'PRODUCT_PACKAGE_INFO_MISSING' });
  assert.throws(() => buildPackage([{ productId: 'x', quantity: 1, info: null }]), { code: 'PRODUCT_PACKAGE_INFO_MISSING' });
  const pkg = buildPackage([{ productId: 'x', quantity: 1, info: ok }]);
  assert.ok(pkg.weightKg > 0 && pkg.lengthCm > 0 && pkg.breadthCm > 0 && pkg.heightCm > 0);
});
