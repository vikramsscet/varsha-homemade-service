'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const repository = require('./guestCheckout.repository');
const { AppError } = require('../../utils/errors');
const { toName } = require('../../utils/country');

const HEADER = 'X-Guest-Checkout-Session';
// 32 random bytes, base64url => exactly 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const EXPIRED_GRACE_SECONDS = 24 * 60 * 60;

const generateToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// request field -> column
const CUSTOMER_COLUMNS = {
  email: 'email', firstName: 'first_name', lastName: 'last_name', phone: 'phone',
};
const ADDRESS_COLUMNS = {
  country: 'country', addressLine1: 'address_line1', addressLine2: 'address_line2',
  city: 'city', state: 'state', postalCode: 'postal_code',
};

const toDto = (r) => {
  const country = r.country ? r.country.trim() : null;
  const dto = {
    id: r.id,
    cartId: r.anonymous_cart_id,
    customer: { email: r.email, firstName: r.first_name, lastName: r.last_name, phone: r.phone },
    deliveryAddress: {
      country,
      countryName: country ? toName(country) : null,
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      city: r.city,
      state: r.state,
      postalCode: r.postal_code,
    },
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const required = [r.email, r.first_name, r.last_name, r.phone, country, r.address_line1, r.city,
    r.state, r.postal_code];
  dto.isComplete = required.every((v) => v !== null && v !== '');
  return dto;
};

// Looks up the session by token hash. Missing/malformed -> 401 INVALID_GUEST_SESSION,
// unknown or deleted -> 401 GUEST_SESSION_NOT_FOUND, past expiry -> 401 GUEST_SESSION_EXPIRED.
const authenticate = async (token) => {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new AppError(401, 'INVALID_GUEST_SESSION', 'Invalid guest checkout session token');
  }
  const row = await repository.findByTokenHash(hashToken(token));
  if (!row) throw new AppError(401, 'GUEST_SESSION_NOT_FOUND', 'Guest checkout session not found');
  if (new Date(row.expires_at) <= new Date()) {
    throw new AppError(401, 'GUEST_SESSION_EXPIRED', 'Guest checkout session has expired');
  }
  return row;
};

const create = async ({ anonymousCartId } = {}) => {
  let cartId = null;
  if (anonymousCartId) {
    const cart = await repository.findActiveCartIdByAnonymousId(anonymousCartId.toLowerCase());
    if (!cart) throw new AppError(404, 'CART_NOT_FOUND', 'No active anonymous cart found');
    cartId = cart.id;
  }

  // Always a brand-new session and token; an existing session is never reused or looked up by cart.
  const token = generateToken();
  const expiresAt = new Date(Date.now() + env.guestCheckout.sessionTtlHours * 3600 * 1000);
  const row = await repository.insert(hashToken(token), cartId, expiresAt);
  return { sessionToken: token, ...toDto(row) };
};

const get = (session) => toDto(session);

const update = async (session, input) => {
  const columns = {};
  const collect = (group, mapping) => {
    for (const [field, column] of Object.entries(mapping)) {
      if (group && group[field] !== undefined) columns[column] = group[field] === '' ? null : group[field];
    }
  };
  collect(input.customer, CUSTOMER_COLUMNS);
  collect(input.deliveryAddress, ADDRESS_COLUMNS);
  if (Object.keys(columns).length === 0) {
    throw new AppError(400, 'INVALID_CHECKOUT_DETAILS', 'No checkout details provided');
  }
  const row = await repository.updateDetails(session.id, columns);
  if (!row) throw new AppError(401, 'GUEST_SESSION_EXPIRED', 'Guest checkout session has expired');
  return toDto(row);
};

// Only the session row is removed; the cart is untouched.
const remove = (session) => repository.remove(session.id);

// Run by the scheduled job (src/jobs/guestSessionCleanup.js). Returns the number of rows deleted.
const cleanupExpired = () => repository.deleteExpired(EXPIRED_GRACE_SECONDS);

module.exports = { HEADER, cleanupExpired, EXPIRED_GRACE_SECONDS, authenticate, create, get, update, remove, hashToken };
