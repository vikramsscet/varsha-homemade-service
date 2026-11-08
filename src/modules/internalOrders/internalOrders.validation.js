'use strict';

const Joi = require('joi');
const { ORDER_STATUSES, MAX_LIMIT, DEFAULT_LIMIT } = require('../orders/orders.validation');

const UUID = Joi.string().guid({ version: ['uuidv1', 'uuidv3', 'uuidv4', 'uuidv5', 'uuidv6', 'uuidv7', 'uuidv8'] });
const PAYMENT_STATUSES = ['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

const base = {
  cursor: Joi.string().pattern(/^[A-Za-z0-9_-]+$/).max(512),
  limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  status: Joi.string().valid(...ORDER_STATUSES),
  paymentStatus: Joi.string().valid(...PAYMENT_STATUSES),
};

const listQuerySchema = Joi.object({
  ...base,
  // eslint-disable-next-line no-control-regex
  search: Joi.string().trim().min(1).max(100).pattern(/^[^\u0000-\u001f\u007f]+$/),
  createdFrom: Joi.date().iso(),
  createdBefore: Joi.date().iso(),
});

const userListQuerySchema = Joi.object(base);
const orderIdParamsSchema = Joi.object({ orderId: UUID.required() });
const userIdParamsSchema = Joi.object({ userId: UUID.required() });

module.exports = { listQuerySchema, userListQuerySchema, orderIdParamsSchema, userIdParamsSchema, PAYMENT_STATUSES };
