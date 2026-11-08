'use strict';

const express = require('express');
const { authRoutes } = require('../modules/auth');
const { cartRoutes } = require('../modules/cart');
const { addressRoutes } = require('../modules/addresses');
const { guestCheckoutRoutes } = require('../modules/guestCheckout');
const { orderRoutes } = require('../modules/orders');
const { paymentRoutes } = require('../modules/payments');
const { shippingRoutes } = require('../modules/shipping');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/carts', cartRoutes);
router.use('/addresses', addressRoutes);
router.use('/guest-checkout', guestCheckoutRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/shipping', shippingRoutes);

module.exports = router;
