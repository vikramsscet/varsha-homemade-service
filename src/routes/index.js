'use strict';

const express = require('express');
const { authRoutes } = require('../modules/auth');
const { cartRoutes } = require('../modules/cart');
const { addressRoutes } = require('../modules/addresses');
const { guestCheckoutRoutes } = require('../modules/guestCheckout');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/carts', cartRoutes);
router.use('/addresses', addressRoutes);
router.use('/guest-checkout', guestCheckoutRoutes);
// Next phase: router.use('/checkout', checkoutRoutes);

module.exports = router;
