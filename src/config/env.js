'use strict';

require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET', 'GOOGLE_CLIENT_ID'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // Names only - never print values.
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

const nodeEnv = process.env.NODE_ENV || 'development';

if (!process.env.PRODUCT_SERVICE_PROVIDER && nodeEnv !== 'test') {
  throw new Error("PRODUCT_SERVICE_PROVIDER must be set explicitly ('http' or 'mock')");
}

module.exports = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: parseInt(process.env.PORT, 10) || 3001,
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  trustProxy: process.env.TRUST_PROXY || '0',
  authRateLimit: {
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20,
    windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  },
  cart: {
    anonymousTtlDays: parseInt(process.env.CART_ANONYMOUS_TTL_DAYS, 10) || 30,
    maxItemQuantity: parseInt(process.env.CART_MAX_ITEM_QUANTITY, 10) || 99,
    maxDistinctItems: parseInt(process.env.CART_MAX_DISTINCT_ITEMS, 10) || 50,
  },
  productService: {
    // 'mock' = built-in sample catalog (development/test only), 'http' = Product CMS over HTTP.
    provider: process.env.PRODUCT_SERVICE_PROVIDER || 'mock',
    baseUrl: (process.env.PRODUCT_SERVICE_URL || '').replace(/\/+$/, ''),
    timeoutMs: parseInt(process.env.PRODUCT_SERVICE_TIMEOUT_MS, 10) || 8000,
  },
  enableDocs: process.env.NODE_ENV !== 'production' || process.env.ENABLE_DOCS === 'true',
});
