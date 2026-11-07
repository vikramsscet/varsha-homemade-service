'use strict';

const Joi = require('joi');

// Only the internal order id is accepted; any amount/currency sent by the client is stripped.
const createPaymentOrderSchema = Joi.object({
  orderId: Joi.string().guid().required(),
});

// Only these four fields are read; everything else (e.g. a client-claimed "status"/"paid") is stripped.
const verifyPaymentSchema = Joi.object({
  internalPaymentId: Joi.string().guid().required(),
  razorpay_order_id: Joi.string().pattern(/^order_[A-Za-z0-9]{1,50}$/).required(),
  razorpay_payment_id: Joi.string().pattern(/^pay_[A-Za-z0-9]{1,50}$/).required(),
  razorpay_signature: Joi.string().pattern(/^[0-9a-fA-F]{64}$/).required()
    .messages({ 'string.pattern.base': '{{#label}} must be a 64-character hex string' }),
});

module.exports = { createPaymentOrderSchema, verifyPaymentSchema };
