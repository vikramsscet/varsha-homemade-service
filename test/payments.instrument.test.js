'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractInstrument, maskVpa, EMPTY } = require('../src/modules/payments/payments.instrument');

test('card: keeps only network/last4/type/issuer, normalised; ignores PAN, CVV and expiry', () => {
  const i = extractInstrument({
    method: 'card',
    card: { network: 'American Express', last4: '0005', type: 'credit', issuer: 'amex', number: '378282246310005', cvv: '1234', expiry_month: 1 },
  });
  assert.deepEqual(i, { ...EMPTY, cardNetwork: 'AMERICAN_EXPRESS', cardLast4: '0005', cardType: 'CREDIT', cardIssuer: 'AMEX' });
  assert.ok(!JSON.stringify(i).includes('378282246310005'));
});

test('card: invalid last4 / unknown type are dropped, not stored', () => {
  const i = extractInstrument({ method: 'card', card: { network: 'Visa', last4: '12345', type: 'weird' } });
  assert.equal(i.cardLast4, null);
  assert.equal(i.cardType, null);
  assert.equal(i.cardNetwork, 'VISA');
});

test('netbanking, wallet and upi (masked) map to their own field only', () => {
  assert.deepEqual(extractInstrument({ method: 'netbanking', bank: 'HDFC' }), { ...EMPTY, bankCode: 'HDFC' });
  assert.deepEqual(extractInstrument({ method: 'wallet', wallet: 'paytm' }), { ...EMPTY, walletName: 'PAYTM' });
  const upi = extractInstrument({ method: 'upi', vpa: 'alice@okhdfc' });
  assert.deepEqual(upi, { ...EMPTY, upiHandleMasked: 'al***@okhdfc' });
  assert.ok(!JSON.stringify(upi).includes('alice@'));
});

test('fields of another method are ignored; missing/garbage input yields all nulls', () => {
  assert.deepEqual(extractInstrument({ method: 'upi', bank: 'HDFC', card: { last4: '4242' } }), EMPTY);
  assert.deepEqual(extractInstrument(null), EMPTY);
  assert.deepEqual(extractInstrument({ method: 'emi' }), EMPTY);
});

test('maskVpa never returns the full handle and rejects malformed input', () => {
  assert.equal(maskVpa('a@b'), 'a***@b');
  assert.equal(maskVpa('nohandle'), null);
  assert.equal(maskVpa('@bank'), null);
  assert.equal(maskVpa(undefined), null);
});
