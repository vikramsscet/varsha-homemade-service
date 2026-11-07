'use strict';

const express = require('express');
const controller = require('./orders.controller');
const auth = require('../../middleware/auth');
const { checkoutIdentity } = require('../../middleware/checkoutIdentity');
const checkoutRateLimit = require('../../middleware/checkoutRateLimit');
const validate = require('../../middleware/validate');
const { createOrderSchema, orderIdParamsSchema } = require('./orders.validation');

const router = express.Router();

router.post('/', checkoutRateLimit, checkoutIdentity(), validate(createOrderSchema), controller.create);

// Order history: logged-in customers only (Bearer JWT). Guest orders are never listed here.
router.get('/', auth, controller.list);
router.get('/:id', auth, validate(orderIdParamsSchema, 'params'), controller.get);

module.exports = router;
