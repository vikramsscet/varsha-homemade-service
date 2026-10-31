'use strict';

const guestSessionService = require('../modules/guestCheckout/guestCheckout.service');
const { AppError } = require('../utils/errors');

/**
 * Authenticates a guest checkout session from the X-Guest-Checkout-Session header and sets
 * req.guestSession. This is independent of JWT auth and of the anonymous cart id: the cart id
 * is never accepted as a credential here.
 */
module.exports = async (req, res, next) => {
  try {
    const token = req.get(guestSessionService.HEADER);
    if (!token) {
      throw new AppError(401, 'INVALID_GUEST_SESSION', `${guestSessionService.HEADER} header required`);
    }
    req.guestSession = await guestSessionService.authenticate(token);
    return next();
  } catch (err) {
    return next(err);
  }
};
