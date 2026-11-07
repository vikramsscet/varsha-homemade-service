'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { failure } = require('../utils/response');

module.exports = rateLimit({
  windowMs: env.authRateLimit.windowMs,
  limit: env.checkout.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => failure(res, 429, 'RATE_LIMITED', 'Too many requests, please try again later'),
});
