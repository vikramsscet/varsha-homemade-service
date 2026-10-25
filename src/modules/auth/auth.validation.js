'use strict';

const Joi = require('joi');

const googleLoginSchema = Joi.object({
  credential: Joi.string().trim().min(20).max(4096).required(),
});

module.exports = { googleLoginSchema };
