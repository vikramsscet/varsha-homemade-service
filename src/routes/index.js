'use strict';

const express = require('express');
const { authRoutes } = require('../modules/auth');
const { cartRoutes } = require('../modules/cart');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/carts', cartRoutes);
// Next phase: router.use('/checkout', checkoutRoutes);

module.exports = router;
