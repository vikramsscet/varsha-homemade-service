'use strict';

// Integration tests against PostgreSQL (migrations 001-011 applied); only run with RUN_DB_TESTS=1.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };

test('order history API (database)', opts, async (t) => {
  const app = require('../src/app');
  const db = require('../src/config/database');
  const { signToken } = require('../src/utils/jwt');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const suffix = Date.now();
  const userIds = [];
  const P1 = '11111111-1111-4111-8111-111111111111';

  t.after(async () => {
    server.close();
    try {
      await db.query('DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id = ANY($1) OR guest_access_token_hash LIKE $2)', [userIds, `hist${suffix}%`]);
      await db.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = ANY($1) OR guest_access_token_hash LIKE $2)', [userIds, `hist${suffix}%`]);
      await db.query('DELETE FROM orders WHERE user_id = ANY($1) OR guest_access_token_hash LIKE $2', [userIds, `hist${suffix}%`]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    } finally {
      await db.close();
    }
  });

  const newUser = async (label) => {
    const u = (await db.query(`INSERT INTO users (email, first_name) VALUES ($1,'T') RETURNING id, email`, [`hist-${label}-${suffix}@example.invalid`])).rows[0];
    userIds.push(u.id);
    return { ...u, auth: { Authorization: `Bearer ${signToken(u)}` } };
  };
  let seq = 0;
  const order = async (u, { status = 'PENDING_PAYMENT', createdAt, total = 100 } = {}) => {
    const paid = status === 'PAID';
    return (await db.query(
      `INSERT INTO orders (customer_type, user_id, status, subtotal, total_amount, customer_email,
         shipping_first_name, shipping_last_name, shipping_phone, shipping_country, shipping_address_line1,
         shipping_city, shipping_state, shipping_postal_code, created_at, paid_at, confirmed_at)
       VALUES ('USER',$1,$2,$3,$3,$4,'Asha','Rao','+918319510666','IN','12 MG Road','Pune','MH','411057',
               COALESCE($5::timestamptz, NOW()), CASE WHEN $6 THEN NOW() END, CASE WHEN $6 THEN NOW() END) RETURNING *`,
      [u.id, status, total, u.email, createdAt || null, paid])).rows[0];
  };
  const item = (o) => db.query(
    `INSERT INTO order_items (order_id, product_id, product_name, product_slug, unit_price, quantity, total_price)
     VALUES ($1,$2,'Besan Laddu (1kg)','besan-laddu-1kg',50,2,100)`, [o.id, P1]);
  const payment = async (o, attempt, { status = 'FAILED', method = null, ...meta } = {}) => (await db.query(
    `INSERT INTO payments (order_id, attempt_number, razorpay_order_id, razorpay_payment_id, status, amount, method,
        card_network, card_last4, card_type, card_issuer, bank_code, wallet_name, upi_handle_masked, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $5::varchar IN ('CAPTURED','PARTIALLY_REFUNDED','REFUNDED') THEN NOW() END)
     RETURNING *`,
    [o.id, attempt, `order_${crypto.randomBytes(6).toString('hex')}`,
      status === 'CREATED' ? null : `pay_${crypto.randomBytes(6).toString('hex')}`, status, o.total_amount, method,
      meta.card_network || null, meta.card_last4 || null, meta.card_type || null, meta.card_issuer || null,
      meta.bank_code || null, meta.wallet_name || null, meta.upi_handle_masked || null])).rows[0];
  const get = async (path, headers) => {
    const res = await fetch(base + path, { headers: headers || {} });
    return { status: res.status, json: await res.json(), headers: res.headers };
  };

  await t.test('requires a Bearer JWT; userId in the query is ignored', async () => {
    assert.equal((await get('/orders')).status, 401);
    assert.equal((await get('/orders', { Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await get(`/orders/${P1}`)).status, 401);
    const a = await newUser('qa');
    const b = await newUser('qb');
    await order(b);
    const r = await get(`/orders?userId=${b.id}`, a.auth);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.items, []);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
  });

  await t.test('lists only the caller\'s own orders: no other customer, no guest orders', async () => {
    const a = await newUser('own-a');
    const b = await newUser('own-b');
    const mine = await order(a);
    await order(b);
    await db.query(
      `INSERT INTO orders (customer_type, user_id, guest_access_token_hash, status, subtotal, total_amount, customer_email,
         shipping_first_name, shipping_last_name, shipping_phone, shipping_country, shipping_address_line1, shipping_city, shipping_state, shipping_postal_code)
       VALUES ('GUEST', NULL, $1, 'PENDING_PAYMENT', 10, 10, $2, 'G','G','+918319510666','IN','x','x','x','411057')`,
      [`hist${suffix}`.padEnd(64, 'a'), a.email]); // same email as the user: still never listed
    const r = await get('/orders', a.auth);
    assert.equal(r.status, 200);
    assert.equal(r.json.message, 'Orders retrieved successfully');
    assert.deepEqual(r.json.data.items.map((i) => i.id), [mine.id]);
    assert.deepEqual(r.json.data.pagination, { nextCursor: null, hasMore: false });
    const keys = Object.keys(r.json.data.items[0]).sort();
    assert.deepEqual(keys, ['createdAt', 'currency', 'discountAmount', 'id', 'orderNumber', 'paymentMethodSummary',
      'paymentStatus', 'shippingAmount', 'status', 'subtotal', 'taxAmount', 'totalAmount']);
    assert.equal(r.json.data.items[0].paymentStatus, null); // no payment attempt yet
  });

  await t.test('cursor pagination: newest first, stable across ties and orders created mid-walk, no duplicates or gaps', async () => {
    const u = await newUser('page');
    const same = '2026-01-01T10:00:00.123456Z'; // identical timestamps: id breaks the tie
    const created = [];
    for (const ts of [same, same, same, '2026-01-02T10:00:00Z', '2026-01-03T10:00:00Z', '2025-12-31T10:00:00Z', same]) {
      created.push(await order(u, { createdAt: ts }));
    }
    const walk = async (extra = '', hook) => {
      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const r = await get(`/orders?limit=2${extra}${cursor ? `&cursor=${cursor}` : ''}`, u.auth);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        seen.push(...r.json.data.items.map((i) => i.id));
        if (hook && guard === 0) await hook();
        if (!r.json.data.pagination.hasMore) { assert.equal(r.json.data.pagination.nextCursor, null); return seen; }
        cursor = r.json.data.pagination.nextCursor;
        assert.ok(cursor);
      }
      throw new Error('pagination did not terminate');
    };
    const ids = await walk();
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7);
    assert.deepEqual([...ids].sort(), created.map((o) => o.id).sort());
    assert.equal(ids[0], created[4].id); // 2026-01-03 newest
    assert.equal(ids[ids.length - 1], created[5].id); // 2025-12-31 oldest
    // a new (newest) order appears after the first page: nothing already seen repeats, nothing is skipped
    const withInsert = await walk('', () => order(u));
    assert.equal(new Set(withInsert).size, withInsert.length);
    for (const o of created) assert.ok(withInsert.includes(o.id), 'missing an original order');
  });

  await t.test('status filter, limit bounds, bad cursor and cursor/filter mismatch -> 400 INVALID_REQUEST', async () => {
    const u = await newUser('filter');
    const paid = await order(u, { status: 'PAID' });
    await order(u, { status: 'PENDING_PAYMENT' });
    await order(u, { status: 'PAID' });
    const r = await get('/orders?status=PAID&limit=1', u.auth);
    assert.equal(r.json.data.items.length, 1);
    assert.ok(r.json.data.items.every((i) => i.status === 'PAID'));
    assert.equal(r.json.data.pagination.hasMore, true);
    const all = await get('/orders?status=PAID', u.auth);
    assert.deepEqual(all.json.data.items.map((i) => i.id).includes(paid.id), true);
    assert.equal(all.json.data.items.length, 2);
    for (const q of ['limit=0', 'limit=51', 'limit=abc', 'status=SHIPPED', 'cursor=garbage',
      `cursor=${r.json.data.pagination.nextCursor}`]) { // last one: cursor issued for status=PAID used with no status
      const bad = await get(`/orders?${q}`, u.auth);
      assert.equal(bad.status, 400, q);
      assert.equal(bad.json.error.code, 'INVALID_REQUEST', q);
    }
  });

  await t.test('order-level payment: captured attempt wins over a later failed one; method summaries from persisted data', async () => {
    const u = await newUser('pay');
    const card = await order(u, { status: 'PAID', createdAt: '2026-03-01T00:00:00Z' });
    await payment(card, 1, { status: 'FAILED', method: 'upi', upi_handle_masked: 'al***@okhdfc' });
    await payment(card, 2, { status: 'CAPTURED', method: 'card', card_network: 'VISA', card_last4: '4242', card_type: 'CREDIT', card_issuer: 'HDFC' });
    const upi = await order(u, { status: 'PAID', createdAt: '2026-03-02T00:00:00Z' });
    await payment(upi, 1, { status: 'CAPTURED', method: 'upi', upi_handle_masked: 'bo***@okicici' });
    const nb = await order(u, { status: 'PAID', createdAt: '2026-03-03T00:00:00Z' });
    await payment(nb, 1, { status: 'CAPTURED', method: 'netbanking', bank_code: 'HDFC' });
    const wallet = await order(u, { status: 'PAID', createdAt: '2026-03-04T00:00:00Z' });
    await payment(wallet, 1, { status: 'CAPTURED', method: 'wallet', wallet_name: 'PAYTM' });
    const failed = await order(u, { status: 'PAYMENT_FAILED', createdAt: '2026-03-05T00:00:00Z' });
    await payment(failed, 1, { status: 'FAILED', method: 'card', card_network: 'MASTERCARD', card_last4: '4444' });
    const open = await order(u, { createdAt: '2026-03-06T00:00:00Z' });
    await payment(open, 1, { status: 'CREATED' });

    const q = db.query.bind(db);
    let calls = 0;
    t.mock.method(db, 'query', (...a) => { calls += 1; return q(...a); });
    const r = await get('/orders?limit=20', u.auth);
    assert.equal(calls <= 2, true, `expected a single history query (plus auth), saw ${calls}`); // no N+1
    t.mock.restoreAll?.();
    const by = Object.fromEntries(r.json.data.items.map((i) => [i.id, i]));
    assert.deepEqual([by[card.id].paymentStatus, by[card.id].paymentMethodSummary], ['CAPTURED', 'Visa •••• 4242']);
    assert.deepEqual([by[upi.id].paymentStatus, by[upi.id].paymentMethodSummary], ['CAPTURED', 'UPI']);
    assert.equal(by[nb.id].paymentMethodSummary, 'HDFC netbanking');
    assert.equal(by[wallet.id].paymentMethodSummary, 'Paytm');
    assert.deepEqual([by[failed.id].paymentStatus, by[failed.id].paymentMethodSummary], ['FAILED', 'Mastercard •••• 4444']);
    assert.deepEqual([by[open.id].paymentStatus, by[open.id].paymentMethodSummary], ['CREATED', null]);
    assert.ok(!JSON.stringify(r.json).includes('@')); // no UPI handle, masked or not
  });

  await t.test('order details: snapshots, every payment attempt, method-appropriate metadata only', async () => {
    const u = await newUser('detail');
    const o = await order(u, { status: 'PAID', total: 100 });
    await item(o);
    const p1 = await payment(o, 1, { status: 'FAILED', method: 'upi', upi_handle_masked: 'al***@okhdfc' });
    const p2 = await payment(o, 2, { status: 'CAPTURED', method: 'card', card_network: 'VISA', card_last4: '4242', card_type: 'CREDIT' });
    // the customer's *current* saved address / catalogue must not matter: change nothing there, snapshot is what is returned
    const r = await get(`/orders/${o.id}`, u.auth);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.message, 'Order retrieved successfully');
    const d = r.json.data;
    assert.deepEqual([d.id, d.orderNumber, d.status, d.totalAmount, d.currency], [o.id, o.order_number, 'PAID', 100, 'INR']);
    assert.deepEqual([d.paymentStatus, d.paymentMethodSummary], ['CAPTURED', 'Visa •••• 4242']);
    assert.deepEqual(d.items, [{ productId: P1, productName: 'Besan Laddu (1kg)', productSlug: 'besan-laddu-1kg', unitPrice: 50, quantity: 2, totalPrice: 100 }]);
    assert.deepEqual(d.shippingAddress, { firstName: 'Asha', lastName: 'Rao', phone: '+918319510666', country: 'IN',
      addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', state: 'MH', postalCode: '411057' });
    assert.deepEqual(d.payments.map((p) => p.paymentId), [p2.id, p1.id]); // newest attempt first, all attempts
    const [card, upi] = d.payments;
    assert.deepEqual([card.paymentStatus, card.paymentMethod, card.amount, card.currency], ['CAPTURED', 'card', 10000, 'INR']);
    assert.deepEqual(card.card, { network: 'Visa', last4: '4242', type: 'credit', issuer: null });
    assert.deepEqual([card.bankCode, card.walletName, card.upiHandleMasked], [null, null, null]);
    assert.ok(card.capturedAt && card.razorpayPaymentId);
    assert.equal(upi.card, null);
    assert.equal(upi.upiHandleMasked, 'al***@okhdfc');
    assert.equal(upi.capturedAt, null);
    // nothing internal leaks
    const text = JSON.stringify(r.json);
    for (const hidden of ['guest', 'token', 'razorpayOrderId', 'razorpay_order_id', 'idempotency', 'userId', 'cartId', 'customer_email']) {
      assert.ok(!text.toLowerCase().includes(hidden.toLowerCase()), `exposes ${hidden}`);
    }
  });

  await t.test('another customer\'s order, a guest order and an unknown id are all the same 404; malformed id is 400', async () => {
    const a = await newUser('own404');
    const b = await newUser('other404');
    const theirs = await order(b);
    const guest = (await db.query(
      `INSERT INTO orders (customer_type, user_id, guest_access_token_hash, status, subtotal, total_amount, customer_email,
         shipping_first_name, shipping_last_name, shipping_phone, shipping_country, shipping_address_line1, shipping_city, shipping_state, shipping_postal_code)
       VALUES ('GUEST', NULL, $1, 'PENDING_PAYMENT', 10, 10, $2, 'G','G','+918319510666','IN','x','x','x','411057') RETURNING id`,
      [`hist${suffix}`.padEnd(63, 'b') + '1', a.email])).rows[0];
    const bodies = [];
    for (const id of [theirs.id, guest.id, crypto.randomUUID()]) {
      const r = await get(`/orders/${id}`, a.auth);
      assert.equal(r.status, 404, id);
      assert.equal(r.json.error.code, 'ORDER_NOT_FOUND');
      bodies.push(JSON.stringify(r.json));
    }
    assert.equal(new Set(bodies).size, 1); // indistinguishable
    const bad = await get('/orders/not-a-uuid', a.auth);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_REQUEST');
    assert.equal((await get(`/orders/${theirs.id}`, b.auth)).status, 200); // the owner can still read it
  });

  await t.test('historical orders without payment metadata (pre-migration rows) read as null, not errors', async () => {
    const u = await newUser('legacy');
    const o = await order(u, { status: 'PAID' });
    await payment(o, 1, { status: 'CAPTURED', method: 'card' }); // captured card, no instrument columns populated
    const d = (await get(`/orders/${o.id}`, u.auth)).json.data;
    assert.equal(d.paymentMethodSummary, 'Card');
    assert.deepEqual(d.payments[0].card, { network: null, last4: null, type: null, issuer: null });
    const l = (await get('/orders', u.auth)).json.data.items[0];
    assert.equal(l.paymentMethodSummary, 'Card');
  });
});
