'use strict';

// Offline tests: POST /api/v1/shipping/rates (cart + product stubbed, Shiprocket via fetch stub).
process.env.NODE_ENV = 'test';
process.env.SHIPROCKET_BASE_URL = 'https://shiprocket.test/v1/external';
process.env.SHIPROCKET_EMAIL = 'ops@example.com';
process.env.SHIPROCKET_PASSWORD = 'super-secret-password';
process.env.SHIPROCKET_PICKUP_PINCODE = '411057';
const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { cartService } = require('../src/modules/cart');
const { productServiceClient } = require('../src/integrations/product');
const shiprocketIntegration = require('../src/integrations/shiprocket');

const realFetch = globalThis.fetch;
const ANON = '5b0e6d0e-7f0b-4b44-9d0a-1b2c3d4e5f60';
const P1 = '11111111-1111-4111-8111-111111111111';
const PKG = { weightGrams: 550, lengthCm: 10, breadthCm: 10, heightCm: 12 };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const courier = (id, name, rate, extra = {}) => ({
  courier_company_id: id, courier_name: name, rate, freight_charge: rate - 10, cod_charges: 10,
  estimated_delivery_days: '4', etd: 'Nov 12, 2026', blocked: 0, ...extra,
});
const list = (...c) => json(200, { status: 200, data: { available_courier_companies: c } });
const router = (answer) => (url) => (url.includes('/auth/login') ? json(200, { token: 'tok' }) : answer(url));

const setup = (t, { shiprocket, pkg = PKG }) => {
  shiprocketIntegration._resetForTests();
  const server = app.listen(0);
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  t.mock.method(productServiceClient, 'getPackageInfo', async () => pkg);
  t.mock.method(cartService, 'getCurrentCart', async () => ({ items: [{ productId: P1, quantity: 1 }], subtotal: 500 }));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith(origin)) return realFetch(url, init);
    calls.push(String(url));
    return shiprocket(String(url), init);
  });
  const post = (body) =>
    realFetch(`${origin}/api/v1/shipping/rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anonymous-Cart-ID': ANON },
      body: JSON.stringify(body),
    });
  return { post, calls };
};
const body = { deliveryPincode: '560001', paymentMethod: 'PREPAID' };
const quiet = (t) => t.mock.method(console, 'error', () => {});

test('multiple couriers: normalized, sorted by charge, courier ids kept, no raw fields', async (t) => {
  const { post } = setup(t, {
    shiprocket: router(() => list(
      courier(12, 'Other Courier', 80, { estimated_delivery_days: '3', etd: 'Nov 11, 2026' }),
      courier(10, 'Delhivery', 65),
      courier(7, 'Blocked One', 40, { blocked: 1 }),
    )),
  });
  const res = await post(body);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    data: {
      deliveryPincode: '560001', serviceable: true, currency: 'INR',
      shippingOptions: [
        { provider: 'SHIPROCKET', courierId: 10, courierName: 'Delhivery', shippingCharge: 65, estimatedDeliveryDays: 4, estimatedDeliveryDate: '2026-11-12' },
        { provider: 'SHIPROCKET', courierId: 12, courierName: 'Other Courier', shippingCharge: 80, estimatedDeliveryDays: 3, estimatedDeliveryDate: '2026-11-11' },
      ],
    },
  });
});

test('charges are Shiprocket\'s rate untouched; different charges sort ascending', async (t) => {
  const { post } = setup(t, { shiprocket: router(() => list(courier(1, 'C', 120.5), courier(2, 'B', 49.25), courier(3, 'A', 75))) });
  const { data } = await (await post(body)).json();
  assert.deepEqual(data.shippingOptions.map((o) => o.shippingCharge), [49.25, 75, 120.5]);
});

test('missing/unparseable ETD info yields null, not a guess', async (t) => {
  const { post } = setup(t, { shiprocket: router(() => list(courier(1, 'C', 50, { etd: '', estimated_delivery_days: null }), courier(2, 'D', 60, { etd: 'garbage' }))) });
  const { data } = await (await post(body)).json();
  for (const o of data.shippingOptions) {
    assert.equal(o.estimatedDeliveryDate, null);
  }
  assert.equal(data.shippingOptions[0].estimatedDeliveryDays, null);
});

test('no available couriers (empty list, all blocked, 404) -> serviceable=false', async (t) => {
  for (const answer of [() => list(), () => list(courier(1, 'X', 50, { blocked: 1 })), () => json(404, { message: 'none' })]) {
    const { post } = setup(t, { shiprocket: router(answer) });
    const res = await post(body);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { deliveryPincode: '560001', serviceable: false, currency: 'INR', shippingOptions: [] });
  }
});

test('COD and PREPAID send the right cod flag and package params', async (t) => {
  for (const [paymentMethod, cod] of [['COD', '1'], ['PREPAID', '0']]) {
    const { post, calls } = setup(t, { shiprocket: router(() => list(courier(1, 'C', 50))) });
    assert.equal((await post({ ...body, paymentMethod })).status, 200);
    const q = new URL(calls.find((u) => u.includes('/courier/'))).searchParams;
    assert.equal(q.get('cod'), cod);
    assert.equal(q.get('weight'), '0.65');
    assert.equal(q.get('declared_value'), '500');
    assert.equal(q.get('pickup_postcode'), '411057');
  }
});

test('invalid PIN code / payment method -> 400, no outbound call', async (t) => {
  const { post, calls } = setup(t, { shiprocket: router(() => list(courier(1, 'C', 50))) });
  assert.equal((await post({ ...body, deliveryPincode: '12345' })).status, 400);
  assert.equal((await post({ deliveryPincode: '560001' })).status, 400);
  assert.equal(calls.length, 0);
});

test('missing package dimensions -> 422, Shiprocket never called', async (t) => {
  const { post, calls } = setup(t, { pkg: { ...PKG, heightCm: null }, shiprocket: router(() => list(courier(1, 'C', 50))) });
  const res = await post(body);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'PRODUCT_PACKAGE_INFO_MISSING');
  assert.equal(calls.length, 0);
});

test('auth failure -> 502 without leaking credentials', async (t) => {
  quiet(t);
  const { post } = setup(t, { shiprocket: () => json(403, { message: 'Invalid email or password' }) });
  const res = await post(body);
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.match(text, /SHIPPING_PROVIDER_AUTH_FAILED/);
  assert.doesNotMatch(text, /super-secret-password|ops@example\.com/);
});

test('timeout -> 504', async (t) => {
  quiet(t);
  const { post } = setup(t, { shiprocket: router(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) });
  const res = await post(body);
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, 'SHIPPING_PROVIDER_TIMEOUT');
});

test('Shiprocket 5xx / invalid body -> 502, raw payload hidden', async (t) => {
  quiet(t);
  for (const answer of [() => json(500, { internal: 'secret-detail' }), () => json(200, { nope: 1 })]) {
    const { post } = setup(t, { shiprocket: router(answer) });
    const res = await post(body);
    assert.equal(res.status, 502);
    assert.doesNotMatch(JSON.stringify(await res.json()), /secret-detail/);
  }
});
