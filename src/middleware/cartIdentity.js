'use strict';

const crypto = require('crypto');
const authenticate = require('./auth');
const { AppError } = require('../utils/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADER = 'x-anonymous-cart-id';

const readAnonymousId = (req) => {
  const raw = req.get(HEADER);
  if (raw === undefined) return null;
  if (!UUID.test(raw)) {
    throw new AppError(400, 'INVALID_ANONYMOUS_CART_ID', 'X-Anonymous-Cart-ID must be a valid UUID');
  }
  return raw.toLowerCase();
};

const hasBearer = (req) => /^Bearer$/i.test((req.get('authorization') || '').split(' ')[0]);

/**
 * Resolves who is calling and sets req.cartOwner = { userId } | { anonymousId }.
 *  - Authorization: Bearer <jwt>  -> authenticated user (an invalid JWT is a 401, never a fallback)
 *  - X-Anonymous-Cart-ID: <uuid>  -> anonymous customer
 * options.allowNewAnonymous: with neither header, mint a new anonymous id (cart creation only).
 */
const cartIdentity = ({ allowNewAnonymous = false } = {}) => (req, res, next) => {
  const resolve = () => {
    if (req.user) {
      req.cartOwner = { userId: req.user.id };
      return next();
    }
    try {
      let anonymousId = readAnonymousId(req);
      if (!anonymousId) {
        if (!allowNewAnonymous) {
          return next(new AppError(401, 'UNAUTHORIZED', 'Bearer token or X-Anonymous-Cart-ID required'));
        }
        anonymousId = crypto.randomUUID();
      }
      req.cartOwner = { anonymousId };
      res.setHeader('X-Anonymous-Cart-ID', anonymousId);
      return next();
    } catch (err) {
      return next(err);
    }
  };

  if (hasBearer(req)) {
    return authenticate(req, res, (err) => (err ? next(err) : resolve()));
  }
  return resolve();
};

// Merge needs BOTH identities: the JWT (target) and the anonymous id that owns the source cart.
const mergeIdentity = (req, res, next) =>
  authenticate(req, res, (err) => {
    if (err) return next(err);
    try {
      const anonymousId = readAnonymousId(req);
      if (!anonymousId) {
        return next(new AppError(400, 'INVALID_ANONYMOUS_CART_ID', 'X-Anonymous-Cart-ID header is required'));
      }
      req.cartOwner = { userId: req.user.id, anonymousId };
      return next();
    } catch (e) {
      return next(e);
    }
  });

module.exports = { cartIdentity, mergeIdentity };
