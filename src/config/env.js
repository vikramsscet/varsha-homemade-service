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

const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
};

// Razorpay credentials come only from the environment. Required in production; elsewhere the
// payment endpoints answer 503 PAYMENT_GATEWAY_NOT_CONFIGURED until they are set.
if (
  nodeEnv === 'production' &&
  (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !process.env.RAZORPAY_WEBHOOK_SECRET)
) {
  throw new Error('RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required in production');
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
  guestCheckout: {
    sessionTtlHours: parseInt(process.env.GUEST_CHECKOUT_SESSION_TTL_HOURS, 10) || 24,
    // 0 disables the in-process cleanup job (e.g. if an external cron runs it instead).
    cleanupIntervalMinutes: Number.isNaN(parseInt(process.env.GUEST_CHECKOUT_CLEANUP_INTERVAL_MINUTES, 10))
      ? 60
      : parseInt(process.env.GUEST_CHECKOUT_CLEANUP_INTERVAL_MINUTES, 10),
  },
  productService: {
    // 'mock' = built-in sample catalog (development/test only), 'http' = Product CMS over HTTP.
    provider: process.env.PRODUCT_SERVICE_PROVIDER || 'mock',
    baseUrl: (process.env.PRODUCT_SERVICE_URL || '').replace(/\/+$/, ''),
    timeoutMs: parseInt(process.env.PRODUCT_SERVICE_TIMEOUT_MS, 10) || 8000,
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    baseUrl: (process.env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com').replace(/\/+$/, ''),
    timeoutMs: parseInt(process.env.RAZORPAY_TIMEOUT_MS, 10) || 10000,
  },
  checkout: {
    // Percentage added on top of (subtotal - discount); 0 = prices already include tax / none applies.
    taxRatePercent: num('CHECKOUT_TAX_RATE_PERCENT', 0),
    shippingFlatFee: num('CHECKOUT_SHIPPING_FLAT_FEE', 0),
    // Shipping is free once (subtotal - discount) reaches this amount; 0 disables the waiver.
    freeShippingThreshold: num('CHECKOUT_FREE_SHIPPING_THRESHOLD', 0),
    paymentWindowMinutes: parseInt(process.env.ORDER_PAYMENT_WINDOW_MINUTES, 10) || 24 * 60,
    rateLimitMax: parseInt(process.env.CHECKOUT_RATE_LIMIT_MAX, 10) || 60,
  },
  enableDocs: process.env.NODE_ENV !== 'production' || process.env.ENABLE_DOCS === 'true',
});
