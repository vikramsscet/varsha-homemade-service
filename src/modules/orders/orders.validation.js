'use strict';

const Joi = require('joi');

const UUID = Joi.string().guid({ version: ['uuidv1', 'uuidv3', 'uuidv4', 'uuidv5', 'uuidv6', 'uuidv7', 'uuidv8'] });

// Amounts, prices, totals, currency etc. are deliberately NOT accepted: they are stripped
// (validate middleware uses stripUnknown) and always computed server-side.
const createOrderSchema = Joi.object({
  addressId: UUID,
}).default({});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,64}$/;

const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAID', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

// userId is never accepted here: it always comes from the JWT.
const listOrdersQuerySchema = Joi.object({
  cursor: Joi.string().max(300),
  limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  status: Joi.string().valid(...ORDER_STATUSES),
});

const orderIdParamsSchema = Joi.object({ id: UUID.required() });

module.exports = {
  createOrderSchema, IDEMPOTENCY_KEY, listOrdersQuerySchema, orderIdParamsSchema, ORDER_STATUSES, MAX_LIMIT, DEFAULT_LIMIT,
};
