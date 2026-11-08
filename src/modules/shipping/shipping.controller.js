'use strict';

const shippingService = require('./shipping.service');

const serviceability = async (req, res, next) => {
  try {
    const data = await shippingService.checkServiceability(req.cartOwner, req.body);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
};

const rates = async (req, res, next) => {
  try {
    const data = await shippingService.getRates(req.cartOwner, req.body);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return next(err);
  }
};

module.exports = { serviceability, rates };
