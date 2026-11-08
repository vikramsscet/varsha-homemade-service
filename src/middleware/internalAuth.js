'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const env = require('../config/env');
const { AppError } = require('../utils/errors');

const digest = (value) => createHash('sha256').update(value).digest();

// Authenticates trusted backend callers (the Admin CMS) with a static shared key.
module.exports = (req, res, next) => {
  if (!env.internalApiKey) {
    return next(new AppError(503, 'INTERNAL_API_DISABLED', 'Internal API is not configured'));
  }
  const provided = req.get('x-internal-api-key');
  if (typeof provided !== 'string' || !timingSafeEqual(digest(provided), digest(env.internalApiKey))) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }
  res.set('Cache-Control', 'private, no-store');
  return next();
};
