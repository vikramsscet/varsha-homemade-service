'use strict';

const express = require('express');
const controller = require('./internalOrders.controller');
const internalAuth = require('../../middleware/internalAuth');
const validate = require('../../middleware/validate');
const { orderIdParamsSchema, userIdParamsSchema } = require('./internalOrders.validation');

// Read-only, server-to-server. Used by the Admin CMS; never called from a browser.
const router = express.Router();

router.use(internalAuth);
router.get('/orders', controller.list);
router.get('/orders/:orderId', validate(orderIdParamsSchema, 'params'), controller.get);
router.get('/users/:userId/orders', validate(userIdParamsSchema, 'params'), controller.listForUser);

module.exports = router;
