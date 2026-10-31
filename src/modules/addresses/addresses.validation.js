'use strict';

const Joi = require('joi');
const { toCode } = require('../../utils/country');

const text = (max) => Joi.string().trim().max(max);
const required = (max) => text(max).min(1).required();

const country = Joi.string()
  .trim()
  .required()
  .custom((value, helpers) => toCode(value) || helpers.error('any.invalid'))
  .messages({ 'any.invalid': '{{#label}} must be a country name or ISO 3166-1 alpha-2 code' });

const fields = {
  firstName: required(100),
  lastName: required(100),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9][0-9\s().-]{5,18}$/)
    .max(20)
    .required()
    .messages({ 'string.pattern.base': '{{#label}} must be a valid phone number' }),
  country,
  addressLine1: required(255),
  addressLine2: text(255).allow('', null),
  city: required(100),
  state: required(100),
  postalCode: Joi.string()
    .trim()
    .pattern(/^[A-Za-z0-9][A-Za-z0-9\s-]{1,18}$/)
    .max(20)
    .required()
    .messages({ 'string.pattern.base': '{{#label}} must be a valid postal code' }),
};

// PUT is a full replacement of the editable fields; isDefault is optional.
const createSchema = Joi.object({ ...fields, isDefault: Joi.boolean().default(false) });
const updateSchema = Joi.object({ ...fields, isDefault: Joi.boolean() });
const addressParams = Joi.object({ id: Joi.string().guid({ separator: '-' }).required() });

module.exports = { createSchema, updateSchema, addressParams, fields };
