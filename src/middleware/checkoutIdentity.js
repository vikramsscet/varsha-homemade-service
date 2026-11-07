'use strict';

const authenticate = require('./auth');
const guestSession = require('./guestSession');
const guestCheckoutService = require('../modules/guestCheckout/guestCheckout.service');
const { AppError } = require('../utils/errors');

const ORDER_TOKEN_HEADER = 'x-guest-order-token';
const ORDER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hasBearer = (req) => /^Bearer$/i.test((req.get('authorization') || '').split(' ')[0]);

/**
 * Sets req.checkoutIdentity:
 *   { type: 'USER', userId, ref }                  Authorization: Bearer <jwt>   (invalid JWT => 401, never a fallback)
 *   { type: 'GUEST', session, ref }                X-Guest-Checkout-Session
 *   { type: 'GUEST', orderTokenHash, ref }         X-Guest-Order-Token (only when allowOrderToken; for retrying
 *                                                   payment after the guest session was cleaned up)
 * The anonymous cart id is never accepted as a credential.
 */
const checkoutIdentity = ({ allowOrderToken = false } = {}) => (req, res, next) => {
  if (hasBearer(req)) {
    return authenticate(req, res, (err) => {
      if (err) return next(err);
      req.checkoutIdentity = { type: 'USER', userId: req.user.id, ref: `u:${req.user.id}` };
      return next();
    });
  }
  if (req.get(guestCheckoutService.HEADER)) {
    return guestSession(req, res, (err) => {
      if (err) return next(err);
      req.checkoutIdentity = { type: 'GUEST', session: req.guestSession, ref: `g:${req.guestSession.id}` };
      return next();
    });
  }
  const orderToken = allowOrderToken ? req.get(ORDER_TOKEN_HEADER) : undefined;
  if (orderToken) {
    if (!ORDER_TOKEN.test(orderToken)) {
      return next(new AppError(401, 'INVALID_GUEST_ORDER_TOKEN', 'Invalid guest order token'));
    }
    const orderTokenHash = guestCheckoutService.hashToken(orderToken);
    req.checkoutIdentity = { type: 'GUEST', orderTokenHash, ref: `t:${orderTokenHash}` };
    return next();
  }
  return next(new AppError(401, 'UNAUTHORIZED', 'Bearer token or guest checkout session required'));
};

module.exports = { checkoutIdentity };
