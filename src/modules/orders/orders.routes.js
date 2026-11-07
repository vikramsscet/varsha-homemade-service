'use strict';

const express = require('express');
const controller = require('./orders.controller');
const { checkoutIdentity } = require('../../middleware/checkoutIdentity');
const checkoutRateLimit = require('../../middleware/checkoutRateLimit');
const validate = require('../../middleware/validate');
const { createOrderSchema } = require('./orders.validation');

const router = express.Router();

router.post('/', checkoutRateLimit, checkoutIdentity(), validate(createOrderSchema), controller.create);

module.exports = router;
