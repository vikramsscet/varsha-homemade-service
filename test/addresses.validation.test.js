'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchema, updateSchema } = require('../src/modules/addresses/addresses.validation');
const { toCode } = require('../src/utils/country');

const valid = {
  firstName: 'Vikram', lastName: 'Rao', phone: '+918319510666', country: 'India',
  addressLine1: 'Beverly Hills Society', addressLine2: 'Building A, Flat 101',
  city: 'Pune', state: 'Maharashtra', postalCode: '411057', isDefault: true,
};

test('country names and codes resolve to alpha-2', () => {
  assert.equal(toCode('India'), 'IN');
  assert.equal(toCode('in'), 'IN');
  assert.equal(toCode('Narnia'), null);
});

test('valid payload passes and country is normalised', () => {
  const { value, error } = createSchema.validate(valid);
  assert.equal(error, undefined);
  assert.equal(value.country, 'IN');
});

test('required fields are enforced', () => {
  for (const key of ['firstName', 'lastName', 'phone', 'country', 'addressLine1', 'city', 'state', 'postalCode']) {
    const { [key]: _omit, ...rest } = valid;
    assert.ok(createSchema.validate(rest).error, `${key} should be required`);
  }
});

test('addressLine2 and isDefault are optional; isDefault defaults to false on create', () => {
  const { addressLine2: _a, isDefault: _d, ...rest } = valid;
  const { value, error } = createSchema.validate(rest);
  assert.equal(error, undefined);
  assert.equal(value.isDefault, false);
  assert.equal(updateSchema.validate(rest).value.isDefault, undefined);
});

test('bad phone, postal code, country and lengths are rejected', () => {
  assert.ok(createSchema.validate({ ...valid, phone: 'abc' }).error);
  assert.ok(createSchema.validate({ ...valid, postalCode: '!!' }).error);
  assert.ok(createSchema.validate({ ...valid, country: 'Narnia' }).error);
  assert.ok(createSchema.validate({ ...valid, city: 'x'.repeat(101) }).error);
  assert.ok(createSchema.validate({ ...valid, firstName: '   ' }).error);
});

test('userId is never accepted from the body (stripped by validate middleware options)', () => {
  const { value } = createSchema.validate({ ...valid, userId: 'x' }, { stripUnknown: true });
  assert.equal('userId' in value, false);
});
