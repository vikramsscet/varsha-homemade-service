'use strict';

const Joi = require('joi');

// Amounts, prices, totals, currency etc. are deliberately NOT accepted: they are stripped
// (validate middleware uses stripUnknown) and always computed server-side.
const createOrderSchema = Joi.object({
  addressId: Joi.string().guid({ version: ['uuidv1', 'uuidv3', 'uuidv4', 'uuidv5', 'uuidv6', 'uuidv7', 'uuidv8'] }),
}).default({});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,64}$/;

module.exports = { createOrderSchema, IDEMPOTENCY_KEY };
