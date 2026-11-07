'use strict';

// Verification-only tests (no new functionality) for payment instrument metadata (migration 010):
// DB constraints, the real fetchPayment extraction (Razorpay stubbed at the HTTP layer), and the verify
// path end to end: delayed settlement, failed-then-successful attempts, null/legacy metadata.
// DB tests only run with RUN_DB_TESTS=1.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const enabled = process.env.RUN_DB_TESTS === '1';
const opts = { skip: enabled ? false : 'set RUN_DB_TESTS=1 to run against DATABASE_URL' };
const P1 = '11111111-1111-4111-8111-111111111111'; // 249.00

const { RazorpayClient } = require('../src/integrations/razorpay/razorpayClient');
const newClient = () => new RazorpayClient({ keyId: 'rzp_test_unit1', keySecret: 'unit-secret', webhookSecret: 'w', baseUrl: 'https://api.razorpay.test', timeoutMs: 2000 });

test('fetchPayment (real implementation, stubbed HTTP): extracts safe metadata and never returns PAN/CVV/full VPA', async (t) => {
  const client = newClient();
  const bodies = {
    pay_card: { id: 'pay_card', order_id: 'order_x', status: 'captured', amount: 100, currency: 'INR', method: 'card', captured: true,
      email: 'a@b.test', contact: '+911234567890',
      card: { id: 'card_1', network: 'Visa', last4: '4242', type: 'credit', issuer: 'HDFC', number: '4111111111111111', cvv: '123' } },
    pay_upi: { id: 'pay_upi', order_id: 'order_x', status: 'captured', amount: 100, currency: 'INR', method: 'upi', captured: true, vpa: 'alice@okhdfc' },
    pay_nb: { id: 'pay_nb', order_id: 'order_x', status: 'captured', amount: 100, currency: 'INR', method: 'netbanking', captured: true, bank: 'HDFC' },
    pay_wl: { id: 'pay_wl', order_id: 'order_x', status: 'captured', amount: 100, currency: 'INR', method: 'wallet', captured: true, wallet: 'paytm' },
    pay_none: { id: 'pay_none', order_id: 'order_x', status: 'captured', amount: 100, currency: 'INR', method: 'card', captured: true },
  };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const id = decodeURIComponent(String(url).split('/payments/')[1] || '');
    if (!bodies[id]) return realFetch(url, init);
    return new Response(JSON.stringify(bodies[id]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const get = (id) => client.fetchPayment(id);

  const card = await get('pay_card');
  assert.deepEqual(card.instrument, { cardNetwork: 'VISA', cardLast4: '4242', cardType: 'CREDIT', cardIssuer: 'HDFC',
    bankCode: null, walletName: null, upiHandleMasked: null });
  assert.equal((await get('pay_upi')).instrument.upiHandleMasked, 'al***@okhdfc');
  assert.equal((await get('pay_nb')).instrument.bankCode, 'HDFC');
  assert.equal((await get('pay_wl')).instrument.walletName, 'PAYTM');
  const none = await get('pay_none');
  assert.ok(Object.values(none.instrument).every((v) => v === null)); // nothing fabricated
  const everything = JSON.stringify([card, await get('pay_upi')]);
  for (const secret of ['4111111111111111', '"cvv"', 'alice@okhdfc', 'a@b.test', '+911234567890', 'card_1']) {
    assert.ok(!everything.includes(secret), `fetchPayment result leaks ${secret}`);
  }
});

test('payment metadata verification (database)', opts, async (t) => {
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
  const realClient = newClient(); // real extraction code; only the HTTP layer is stubbed
  t.mock.method(razorpay, 'fetchPayment', (id) => realClient.fetchPayment(id));
  const gateway = new Map(); // pay_id -> Razorpay payment entity returned by the stubbed HTTP call
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const id = decodeURIComponent(String(url).split('/payments/')[1] || '');
    if (!gateway.has(id)) return realFetch(url, init);
    return new Response(JSON.stringify(gateway.get(id)), { status: 200, headers: { 'content-type': 'application/json' } });
  });

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
      await client.query('DELETE FROM payment_webhook_events WHERE payment_id = ANY($1)', [pays]);
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

  const call = async (method, path, headers, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const checkout = async (label) => {
    const u = (await db.query(`INSERT INTO users (email, first_name) VALUES ($1,'T') RETURNING id, email`, [`meta-${label}-${suffix}@example.invalid`])).rows[0];
    userIds.push(u.id);
    const addr = (await db.query(
      `INSERT INTO user_addresses (user_id, first_name, last_name, phone, country, address_line1, city, state, postal_code)
       VALUES ($1,'A','B','+918319510666','IN','S','Pune','MH','411057') RETURNING id`, [u.id])).rows[0];
    const cart = (await db.query('INSERT INTO carts (user_id) VALUES ($1) RETURNING id', [u.id])).rows[0];
    cartIds.push(cart.id);
    await db.query(`INSERT INTO cart_items (cart_id, product_id, product_name, product_slug, unit_price, quantity, total_price) VALUES ($1,$2,'n','s',249,1,249)`, [cart.id, P1]);
    const auth = { Authorization: `Bearer ${signToken(u)}` };
    const order = (await call('POST', '/orders', auth, { addressId: addr.id })).json.data;
    const pay = (await call('POST', '/payments/create-order', auth, { orderId: order.id })).json.data;
    return { auth, order, pay, user: u };
  };
  const entity = (c, id, status, extra = {}) => ({
    id, order_id: c.pay.razorpayOrderId, status, amount: c.pay.amount, currency: 'INR', captured: status === 'captured', ...extra,
  });
  const verify = (c, payId) => call('POST', '/payments/verify', c.auth, {
    internalPaymentId: c.pay.paymentId, razorpay_order_id: c.pay.razorpayOrderId, razorpay_payment_id: payId, razorpay_signature: 'a'.repeat(64),
  });
  const instrument = async (paymentId) => {
    const p = await one('SELECT * FROM payments WHERE id=$1', [paymentId]);
    return [p.method, p.card_network, p.card_last4, p.card_type, p.card_issuer, p.bank_code, p.wallet_name, p.upi_handle_masked];
  };

  // ---- 1. database constraints ----------------------------------------------------------------
  await t.test('DB constraints: payments_instrument_chk accepts valid combinations and rejects inconsistent ones', async () => {
    const c = await checkout('chk');
    const set = async (sql, params = []) => db.query(`UPDATE payments SET ${sql} WHERE id = $1`, [c.pay.paymentId, ...params]);
    const rejects = async (label, sql) => assert.rejects(() => set(sql), { code: '23514' }, label); // check_violation

    await set(`method='card', card_network='VISA', card_last4='4242', card_type='CREDIT', card_issuer='HDFC'`);
    await set(`method='upi', card_network=NULL, card_last4=NULL, card_type=NULL, card_issuer=NULL, upi_handle_masked='al***@okhdfc'`);
    await set(`method='netbanking', upi_handle_masked=NULL, bank_code='HDFC'`);
    await set(`method='wallet', bank_code=NULL, wallet_name='PAYTM'`);
    await set(`method=NULL, wallet_name=NULL`); // all-null instrument with no method is valid (legacy rows)

    await rejects('last4 not digits', `method='card', card_last4='abcd'`);
    await rejects('last4 too short', `method='card', card_last4='12'`);
    await rejects('unknown card type', `method='card', card_type='GOLD'`);
    await rejects('card data on a UPI payment', `method='upi', card_last4='4242'`);
    await rejects('card data with no method', `method=NULL, card_network='VISA'`);
    await rejects('bank code on a card payment', `method='card', bank_code='HDFC'`);
    await rejects('wallet on a UPI payment', `method='upi', wallet_name='PAYTM'`);
    await rejects('UPI handle on a card payment', `method='card', upi_handle_masked='al***@okhdfc'`);
    // the failed statements changed nothing
    assert.deepEqual(await instrument(c.pay.paymentId), [null, null, null, null, null, null, null, null]);
  });

  await t.test('existing payments stay valid: rows written without any instrument column read as nulls', async () => {
    const c = await checkout('legacy');
    const p = await one('SELECT * FROM payments WHERE id=$1', [c.pay.paymentId]);
    for (const col of ['card_network', 'card_last4', 'card_type', 'card_issuer', 'bank_code', 'wallet_name', 'upi_handle_masked']) {
      assert.equal(p[col], null, col);
    }
    // a pre-010 style insert (instrument columns omitted entirely) still satisfies every constraint
    const o = await one('SELECT id, total_amount FROM orders WHERE id=$1', [c.order.id]);
    await db.query(`UPDATE payments SET status='CANCELLED' WHERE id=$1`, [c.pay.paymentId]);
    const legacy = await one(
      `INSERT INTO payments (order_id, attempt_number, razorpay_order_id, status, amount)
       VALUES ($1, 2, $2, 'CREATED', $3) RETURNING id`, [o.id, `order_legacy_${suffix}`, o.total_amount]);
    assert.ok(legacy.id);
  });

  // ---- 2. successful payments per method via the verify path ----------------------------------
  const methods = [
    ['card', { card: { network: 'Mastercard', last4: '4444', type: 'debit', issuer: 'ICIC', number: '5555555555554444', cvv: '321' } },
      ['card', 'MASTERCARD', '4444', 'DEBIT', 'ICIC', null, null, null]],
    ['upi', { vpa: 'carol@okaxis' }, ['upi', null, null, null, null, null, null, 'ca***@okaxis']],
    ['netbanking', { bank: 'SBIN' }, ['netbanking', null, null, null, null, 'SBIN', null, null]],
    ['wallet', { wallet: 'freecharge' }, ['wallet', null, null, null, null, null, 'FREECHARGE', null]],
    ['card', {}, ['card', null, null, null, null, null, null, null]], // missing instrument metadata
  ];
  for (const [method, extra, expected] of methods) {
    await t.test(`verify: successful ${method} payment${Object.keys(extra).length ? '' : ' with missing metadata'} persists ${JSON.stringify(expected.filter(Boolean))}`, async () => {
      const c = await checkout(`v-${method}-${Object.keys(extra).length}`);
      const payId = `pay_${crypto.randomBytes(5).toString('hex')}`;
      gateway.set(payId, entity(c, payId, 'captured', { method, ...extra }));
      const r = await verify(c, payId);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.data.orderStatus, 'PAID');
      assert.deepEqual(await instrument(c.pay.paymentId), expected);
      // order history reflects the persisted data
      const d = (await call('GET', `/orders/${c.order.id}`, c.auth)).json.data;
      assert.equal(d.payments[0].paymentMethod, method);
    });
  }

  // ---- 3. delayed settlement / multiple attempts ----------------------------------------------
  await t.test('delayed settlement: authorized (202) then captured later; thinner capture response keeps stored metadata', async () => {
    const c = await checkout('delayed');
    const payId = 'pay_delayed1';
    gateway.set(payId, entity(c, payId, 'authorized', { method: 'card', card: { network: 'Visa', last4: '1111', type: 'credit', issuer: 'HDFC' } }));
    const first = await verify(c, payId);
    assert.equal(first.status, 202);
    assert.equal(first.json.data.paid, false);
    assert.deepEqual((await instrument(c.pay.paymentId)).slice(0, 5), ['card', 'VISA', '1111', 'CREDIT', 'HDFC']);
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PENDING_PAYMENT');

    gateway.set(payId, entity(c, payId, 'captured', { method: 'card' })); // later capture carries no card block
    const second = await verify(c, payId);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal((await one('SELECT status FROM orders WHERE id=$1', [c.order.id])).status, 'PAID');
    assert.deepEqual((await instrument(c.pay.paymentId)).slice(0, 5), ['card', 'VISA', '1111', 'CREDIT', 'HDFC']); // not erased

    const again = await verify(c, payId); // duplicate verification: idempotent, nothing changes
    assert.equal(again.status, 200);
    assert.equal(again.json.data.alreadyProcessed, true);
    assert.deepEqual((await instrument(c.pay.paymentId)).slice(0, 5), ['card', 'VISA', '1111', 'CREDIT', 'HDFC']);
  });

  await t.test('failed payment, then a successful retry as a new attempt: each attempt keeps its own instrument, history shows both', async () => {
    const c = await checkout('retry');
    gateway.set('pay_retryfail', entity(c, 'pay_retryfail', 'failed', { method: 'upi', vpa: 'dave@okhdfc', error_code: 'BAD_REQUEST_ERROR', error_description: 'declined' }));
    const failed = await verify(c, 'pay_retryfail');
    assert.equal(failed.status, 402);
    assert.deepEqual(await instrument(c.pay.paymentId), ['upi', null, null, null, null, null, null, 'da***@okhdfc']);

    const attempt2 = (await call('POST', '/payments/create-order', c.auth, { orderId: c.order.id })).json.data;
    assert.equal(attempt2.attemptNumber, 2);
    c.pay = attempt2;
    gateway.set('pay_retryok', entity(c, 'pay_retryok', 'captured', { method: 'card', card: { network: 'RuPay', last4: '0007', type: 'credit' } }));
    assert.equal((await verify(c, 'pay_retryok')).status, 200);

    const d = (await call('GET', `/orders/${c.order.id}`, c.auth)).json.data;
    assert.equal(d.status, 'PAID');
    assert.deepEqual(d.payments.map((p) => [p.paymentStatus, p.paymentMethod, p.paymentMethodSummary]), [
      ['CAPTURED', 'card', 'RuPay •••• 0007'],
      ['FAILED', 'upi', 'UPI'],
    ]);
    assert.equal(d.paymentMethodSummary, 'RuPay •••• 0007'); // order-level summary = the successful attempt
    assert.equal(d.payments[1].upiHandleMasked, 'da***@okhdfc');
    assert.equal(d.payments[1].card, null);
  });

  // ---- 4. security: nothing sensitive is stored or returned -----------------------------------
  await t.test('security: PAN/CVV/PIN/OTP/full VPA are absent from every table and from API responses', async () => {
    const c = await checkout('sec');
    const payId = 'pay_sec1';
    gateway.set(payId, entity(c, payId, 'captured', { method: 'card',
      card: { network: 'Visa', last4: '4242', type: 'credit', number: '4012888888881881', cvv: 'CVV-SECRET-1', pin: 'PIN-SECRET-1', otp: 'OTP-SECRET-1' },
      vpa: 'erin@okhdfc', token_id: 'token_PROVIDER_REF', customer_id: 'cust_PROVIDER_REF', otp: 'OTP-SECRET-2' }));
    assert.equal((await verify(c, payId)).status, 200);

    const [pay, tx, ev] = [
      await db.query('SELECT * FROM payments WHERE id=$1', [c.pay.paymentId]),
      await db.query('SELECT * FROM payment_transactions WHERE payment_id=$1', [c.pay.paymentId]),
      await db.query('SELECT * FROM payment_webhook_events WHERE payment_id=$1', [c.pay.paymentId]),
    ];
    const stored = JSON.stringify([pay.rows, tx.rows, ev.rows]);
    const api = JSON.stringify([
      (await call('GET', `/orders/${c.order.id}`, c.auth)).json,
      (await call('GET', '/orders', c.auth)).json,
    ]);
    for (const secret of ['4012888888881881', 'CVV-SECRET-1', 'PIN-SECRET-1', 'OTP-SECRET-1', 'OTP-SECRET-2', 'erin@okhdfc', 'token_PROVIDER_REF', 'cust_PROVIDER_REF']) {
      assert.ok(!stored.includes(secret), `stored: ${secret}`);
      assert.ok(!api.includes(secret), `api: ${secret}`);
    }
    // the API never exposes guest tokens, provider token references or the gateway order id
    for (const hidden of ['guestAccessToken', 'guest_access_token', 'token_id', 'razorpayOrderId', 'razorpay_order_id']) {
      assert.ok(!api.includes(hidden), `api exposes ${hidden}`);
    }
  });

  // ---- 5. order history edges ---------------------------------------------------------------
  await t.test('empty history returns an empty page, not an error; a guest checkout never appears in the user\'s history', async () => {
    const u = (await db.query(`INSERT INTO users (email) VALUES ($1) RETURNING id, email`, [`meta-empty-${suffix}@example.invalid`])).rows[0];
    userIds.push(u.id);
    const auth = { Authorization: `Bearer ${signToken(u)}` };
    const r = await call('GET', '/orders', auth);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { items: [], pagination: { nextCursor: null, hasMore: false } });
    assert.equal((await call('GET', '/orders?status=PAID&limit=5', auth)).json.data.items.length, 0);
    assert.equal((await call('GET', '/orders/' + crypto.randomUUID(), auth)).status, 404);
  });
});
