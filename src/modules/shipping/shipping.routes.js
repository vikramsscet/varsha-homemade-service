'use strict';

const express = require('express');
const controller = require('./shipping.controller');
const { cartIdentity } = require('../../middleware/cartIdentity');
const validate = require('../../middleware/validate');
const rateLimit = require('../../middleware/checkoutRateLimit');
const { serviceabilitySchema } = require('./shipping.validation');

const router = express.Router();

// Same caller identity as the cart (JWT or X-Anonymous-Cart-ID): the package is derived from their cart.
router.post(
  '/serviceability',
  rateLimit,
  cartIdentity(),
  validate(serviceabilitySchema),
  controller.serviceability
);
router.post('/rates', rateLimit, cartIdentity(), validate(serviceabilitySchema), controller.rates);

module.exports = router;
