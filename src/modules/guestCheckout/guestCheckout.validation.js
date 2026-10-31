'use strict';

const Joi = require('joi');
const { fields } = require('../addresses/addresses.validation');

// Partial updates: every field is optional, but each provided group must contain something.
const opt = (schema) => schema.optional();

const customer = Joi.object({
  email: Joi.string().trim().lowercase().max(320).email({ tlds: { allow: false } }),
  firstName: opt(fields.firstName),
  lastName: opt(fields.lastName),
  phone: opt(fields.phone),
}).min(1);

const deliveryAddress = Joi.object({
  country: opt(fields.country),
  addressLine1: opt(fields.addressLine1),
  addressLine2: fields.addressLine2,
  city: opt(fields.city),
  state: opt(fields.state),
  postalCode: opt(fields.postalCode),
}).min(1);

// Unknown keys (expiresAt, anonymousCartId, tokenHash, ...) are stripped by validate().
const updateSchema = Joi.object({ customer, deliveryAddress }).or('customer', 'deliveryAddress');

// anonymousCartId is the anonymous cart id the client already holds (X-Anonymous-Cart-ID).
const createSchema = Joi.object({ anonymousCartId: Joi.string().guid({ separator: '-' }) }).default({});

module.exports = { createSchema, updateSchema };
