'use strict';

// Offline tests (no database): the internal read-only order API used by the Admin CMS.
// db.query is mocked, so these verify auth, validation, SQL parameterisation, cursors and projection.
process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = 'k'.repeat(40);
const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const db = require('../src/config/database');

const KEY = process.env.INTERNAL_API_KEY;
const ORDER_ID = '0b0a6c34-0f4e-4b9b-9d39-5d3c1f0a1111';
const USER_ID = 'b094b9e4-de81-4fff-864c-d52ce853ff11';

const base = (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/internal/v1`;
};
const get = (url, key = KEY) => fetch(url, { headers: key ? { 'X-Internal-Api-Key': key } : {} });

const orderRow = (n, overrides = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  order_number: `VH261106-1000${n}`,
  status: 'PAID',
  currency: 'INR',
  subtotal: '500.00', discount_amount: '0.00', tax_amount: '0.00', shipping_amount: '50.00', total_amount: '550.00',
  customer_type: 'GUEST', user_id: null,
  customer_email: 'guest@example.com', customer_phone: '+911234567890',
  shipping_first_name: 'Asha', shipping_last_name: 'Rao',
  user_first_name: null, user_last_name: null,
  created_at: new Date('2026-11-06T10:00:00Z'), paid_at: new Date('2026-11-06T10:05:00Z'),
  cursor_ts: `2026-11-06T10:00:0${n}.000000Z`,
  payment_status: 'CAPTURED', payment_method: 'card', card_network: 'VISA', card_last4: '4242',
  bank_code: null, wallet_name: null,
  ...overrides,
});

test('internal API requires the shared key', async (t) => {
  const url = base(t);
  t.mock.method(db, 'query', async () => ({ rows: [] }));
  assert.equal((await get(`${url}/orders`, null)).status, 401);
  assert.equal((await get(`${url}/orders`, 'wrong')).status, 401);
  assert.equal((await get(`${url}/orders`)).status, 200);
});

test('lists orders across customers with filters as bound parameters and a stable cursor', async (t) => {
  const url = base(t);
  const calls = [];
  const rows = [orderRow(3), orderRow(2, { customer_type: 'USER', user_id: USER_ID, user_first_name: 'Vik' }), orderRow(1)];
  t.mock.method(db, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows }; });

  const res = await get(`${url}/orders?limit=2&status=PAID&paymentStatus=CAPTURED&search=50%25_x&createdFrom=2026-11-01T00:00:00.000Z`);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.items.length, 2);
  assert.equal(data.pagination.hasMore, true);
  assert.equal(data.items[0].customer.customerType, 'GUEST');
  assert.equal(data.items[0].customer.userId, null);
  assert.equal(data.items[1].customer.customerType, 'REGISTERED');
  assert.equal(data.items[1].customer.userId, USER_ID);
  assert.equal(data.items[1].customer.firstName, 'Vik');
  assert.equal(data.items[0].paymentMethodSummary, 'Visa •••• 4242');

  const { sql, params } = calls[0];
  assert.match(sql, /ORDER BY o\.created_at DESC, o\.id DESC/);
  assert.equal(sql.includes('OFFSET'), false);
  assert.equal(sql.includes('50%'), false, 'search text must never be in the SQL text');
  assert.ok(params.includes('PAID') && params.includes('CAPTURED'));
  assert.ok(params.includes('50\\%\\_x%'), 'LIKE wildcards in the search term are escaped');
  assert.equal(params[params.length - 1], 3, 'fetches limit + 1 rows');

  // The cursor continues strictly after the last returned row and is bound to the filters.
  calls.length = 0;
  const next = await get(`${url}/orders?limit=2&status=PAID&paymentStatus=CAPTURED&search=50%25_x&createdFrom=2026-11-01T00:00:00.000Z&cursor=${data.pagination.nextCursor}`);
  assert.equal(next.status, 200);
  assert.match(calls[0].sql, /\(o\.created_at, o\.id\) < \(/);
  assert.ok(calls[0].params.includes('2026-11-06T10:00:02.000000Z'));

  const other = await get(`${url}/orders?limit=2&status=REFUNDED&cursor=${data.pagination.nextCursor}`);
  assert.equal(other.status, 400);
  assert.deepEqual((await other.json()).error.details, [{ field: 'cursor', message: 'cursor is invalid' }]);
});

test('rejects invalid list parameters', async (t) => {
  const url = base(t);
  let called = false;
  t.mock.method(db, 'query', async () => { called = true; return { rows: [] }; });
  for (const q of ['limit=51', 'status=NOPE', 'paymentStatus=NOPE', 'createdFrom=yesterday', 'cursor=a%20b', 'cursor=bm9wZQ']) {
    assert.equal((await get(`${url}/orders?${q}`)).status, 400, q);
  }
  assert.equal(called, false);
});

test('order detail returns snapshots and masked payment metadata only', async (t) => {
  const url = base(t);
  const order = {
    ...orderRow(1), shipping_phone: '+911234567890', shipping_country: 'IN ', shipping_address_line1: '1 Main St',
    shipping_address_line2: null, shipping_city: 'Pune', shipping_state: 'MH', shipping_postal_code: '411001',
    confirmed_at: new Date(), cancelled_at: null, updated_at: new Date(),
    guest_access_token_hash: 'must-not-leak',
  };
  const payment = {
    id: USER_ID, attempt_number: 1, razorpay_payment_id: 'pay_1', status: 'CAPTURED', method: 'upi', amount: '550.00',
    amount_refunded: '0.00', currency: 'INR', card_network: null, card_last4: null, card_type: null, card_issuer: null,
    bank_code: null, wallet_name: null, upi_handle_masked: 'ab***@okhdfc', failure_code: null, failure_reason: null,
    created_at: new Date(), authorized_at: null, captured_at: new Date(), failed_at: null,
  };
  t.mock.method(db, 'query', async (sql) => {
    if (sql.includes('FROM orders o')) return { rows: [order] };
    if (sql.includes('FROM order_items')) return { rows: [{ product_id: USER_ID, product_name: 'Chakli', product_slug: 'chakli', unit_price: '250.00', quantity: 2, total_price: '500.00' }] };
    return { rows: [payment] };
  });
  const res = await get(`${url}/orders/${ORDER_ID}`);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.items[0].productName, 'Chakli');
  assert.equal(data.shippingAddress.country, 'IN');
  assert.equal(data.payments[0].upiHandleMasked, 'ab***@okhdfc');
  assert.equal(data.payments[0].amount, 550);
  assert.equal(JSON.stringify(data).includes('must-not-leak'), false);
});

test('order detail 404 / invalid id, and per-user list is scoped to the user', async (t) => {
  const url = base(t);
  const calls = [];
  t.mock.method(db, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; });
  assert.equal((await get(`${url}/orders/not-a-uuid`)).status, 400);
  const missing = await get(`${url}/orders/${ORDER_ID}`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'ORDER_NOT_FOUND');

  calls.length = 0;
  const res = await get(`${url}/users/${USER_ID}/orders`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { items: [], pagination: { nextCursor: null, hasMore: false } });
  assert.match(calls[0].sql, /o\.user_id = \$1/);
  assert.match(calls[0].sql, /o\.customer_type = 'USER'/);
  assert.equal(calls[0].params[0], USER_ID);
  assert.equal((await get(`${url}/users/nope/orders`)).status, 400);
});
