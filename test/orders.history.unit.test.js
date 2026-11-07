'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentMethodSummary, encodeCursor, decodeCursor, networkLabel } = require('../src/modules/orders/orders.history');
const { listOrdersQuerySchema, orderIdParamsSchema } = require('../src/modules/orders/orders.validation');

test('payment summary: card, upi, netbanking, wallet, unknown', () => {
  assert.equal(paymentMethodSummary({ method: 'card', card_network: 'VISA', card_last4: '4242' }), 'Visa •••• 4242');
  assert.equal(paymentMethodSummary({ method: 'card', card_network: 'AMERICAN_EXPRESS', card_last4: '0005' }), 'American Express •••• 0005');
  assert.equal(paymentMethodSummary({ method: 'card', card_network: 'RUPAY', card_last4: '1111' }), 'RuPay •••• 1111');
  assert.equal(paymentMethodSummary({ method: 'upi', upi_handle_masked: 'al***@okhdfc' }), 'UPI');
  assert.equal(paymentMethodSummary({ method: 'netbanking', bank_code: 'HDFC' }), 'HDFC netbanking');
  assert.equal(paymentMethodSummary({ method: 'wallet', wallet_name: 'PAYTM' }), 'Paytm');
  assert.equal(paymentMethodSummary({ method: 'emi' }), 'Emi');
  assert.equal(paymentMethodSummary({ method: null }), null);
});

test('payment summary degrades gracefully when metadata is missing and never exposes a UPI handle', () => {
  assert.equal(paymentMethodSummary({ method: 'card' }), 'Card');
  assert.equal(paymentMethodSummary({ method: 'card', card_network: 'VISA' }), 'Visa card');
  assert.equal(paymentMethodSummary({ method: 'card', card_last4: '4242' }), 'Card •••• 4242');
  assert.equal(paymentMethodSummary({ method: 'netbanking' }), 'Netbanking');
  assert.equal(paymentMethodSummary({ method: 'wallet' }), 'Wallet');
  assert.ok(!paymentMethodSummary({ method: 'upi', upi_handle_masked: 'al***@okhdfc' }).includes('@'));
  assert.equal(networkLabel('SOME_NEW_NETWORK'), 'Some New Network');
});

test('cursor round-trips and is bound to the status filter', () => {
  const row = { cursor_ts: '2026-11-07T10:00:00.123456Z', id: '0c9d5f8e-1b7a-4d0e-8e57-3a6f2b9c4d10' };
  const c = encodeCursor(row, 'PAID');
  assert.deepEqual(decodeCursor(c, 'PAID'), { createdAt: row.cursor_ts, id: row.id });
  assert.throws(() => decodeCursor(c, undefined), { code: 'INVALID_REQUEST' });
  assert.throws(() => decodeCursor(c, 'REFUNDED'), { code: 'INVALID_REQUEST' });
});

test('malformed or forged cursors are rejected', () => {
  for (const bad of ['', 'not-base64-json', Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ t: "2026-01-01'; DROP TABLE orders;--", i: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ t: '2026-11-07T10:00:00.123456Z', i: 'not-a-uuid' })).toString('base64url')]) {
    assert.throws(() => decodeCursor(bad, undefined), { code: 'INVALID_REQUEST' }, bad);
  }
});

test('list query validation: defaults, bounds, status enum, unknown keys (userId) stripped', () => {
  const ok = listOrdersQuerySchema.validate({ userId: 'x' }, { stripUnknown: true });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.limit, 10);
  assert.equal(ok.value.userId, undefined);
  assert.equal(listOrdersQuerySchema.validate({ limit: '25', status: 'PAID' }).value.limit, 25);
  for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 'abc' }, { status: 'SHIPPED' }, { status: 'paid' }]) {
    assert.ok(listOrdersQuerySchema.validate(bad).error, JSON.stringify(bad));
  }
  assert.ok(orderIdParamsSchema.validate({ id: 'nope' }).error);
});
