'use strict';

const Joi = require('joi');

const PAYMENT_METHODS = ['PREPAID', 'COD'];

// Weight/dimensions are deliberately absent: unknown fields are stripped, so clients cannot supply them.
const serviceabilitySchema = Joi.object({
  deliveryPincode: Joi.string()
    .pattern(/^\d{6}$/)
    .required()
    .messages({ 'string.pattern.base': 'deliveryPincode must be exactly 6 digits' }),
  paymentMethod: Joi.string()
    .valid(...PAYMENT_METHODS)
    .required()
    .messages({ 'any.only': `paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}` }),
});

module.exports = { serviceabilitySchema, PAYMENT_METHODS };
