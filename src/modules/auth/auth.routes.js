'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../../config/env');
const controller = require('./auth.controller');
const authenticate = require('../../middleware/auth');
const validate = require('../../middleware/validate');
const { googleLoginSchema } = require('./auth.validation');
const { failure } = require('../../utils/response');

const authLimiter = rateLimit({
  windowMs: env.authRateLimit.windowMs,
  limit: env.authRateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    failure(res, 429, 'RATE_LIMITED', 'Too many authentication attempts, please try again later'),
});

const router = express.Router();

router.post('/google', authLimiter, validate(googleLoginSchema), controller.googleLogin);
router.get('/me', authenticate, controller.me);

module.exports = router;
