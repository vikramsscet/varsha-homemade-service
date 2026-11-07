'use strict';

const express = require('express');
const controller = require('./payments.controller');
const { checkoutIdentity } = require('../../middleware/checkoutIdentity');
const checkoutRateLimit = require('../../middleware/checkoutRateLimit');
const validate = require('../../middleware/validate');
const { createPaymentOrderSchema, verifyPaymentSchema } = require('./payments.validation');

const router = express.Router();

router.post(
  '/create-order',
  checkoutRateLimit,
  checkoutIdentity({ allowOrderToken: true }),
  validate(createPaymentOrderSchema),
  controller.createOrder
);

router.post(
  '/verify',
  checkoutRateLimit,
  checkoutIdentity({ allowOrderToken: true }),
  validate(verifyPaymentSchema),
  controller.verify
);

// Raw-body parsing for this path is configured in app.js. No identity middleware: Razorpay calls it.
router.post('/webhook', controller.webhook);

module.exports = router;
