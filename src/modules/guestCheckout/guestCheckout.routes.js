'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../../config/env');
const controller = require('./guestCheckout.controller');
const guestSession = require('../../middleware/guestSession');
const validate = require('../../middleware/validate');
const { createSchema, updateSchema } = require('./guestCheckout.validation');
const { failure } = require('../../utils/response');

const createLimiter = rateLimit({
  windowMs: env.authRateLimit.windowMs,
  limit: env.authRateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => failure(res, 429, 'RATE_LIMITED', 'Too many requests, please try again later'),
});

const router = express.Router();

router.post('/sessions', createLimiter, validate(createSchema), controller.create);

// JWT is not used here; these routes accept only the guest checkout session token.
router.get('/sessions/current', guestSession, controller.get);
router.put('/sessions/current', guestSession, validate(updateSchema), controller.update);
router.delete('/sessions/current', guestSession, controller.remove);

module.exports = router;
