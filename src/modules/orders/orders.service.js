'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../config/database');
const repository = require('./orders.repository');
const pricing = require('./orders.pricing');
const paymentsRepository = require('../payments/payments.repository');
const addressRepository = require('../addresses/addresses.repository');
const { usersRepository } = require('../users');
const guestCheckoutService = require('../guestCheckout/guestCheckout.service');
const { productServiceClient } = require('../../integrations/product');
const { AppError } = require('../../utils/errors');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const money = (v) => Number(v).toFixed(2);

// ---- response mapping -------------------------------------------------------------------------
const toView = (order, items, extra = {}) => ({
  id: order.id,
  orderNumber: order.order_number,
  status: order.status,
  customerType: order.customer_type,
  cartId: order.cart_id,
  currency: order.currency,
  subtotal: Number(order.subtotal),
  discountAmount: Number(order.discount_amount),
  taxAmount: Number(order.tax_amount),
  shippingAmount: Number(order.shipping_amount),
  totalAmount: Number(order.total_amount),
  amountInPaise: pricing.toMinor(order.total_amount),
  customer: { email: order.customer_email, phone: order.customer_phone },
  shippingAddress: {
    firstName: order.shipping_first_name,
    lastName: order.shipping_last_name,
    phone: order.shipping_phone,
    country: order.shipping_country.trim(),
    addressLine1: order.shipping_address_line1,
    addressLine2: order.shipping_address_line2,
    city: order.shipping_city,
    state: order.shipping_state,
    postalCode: order.shipping_postal_code,
  },
  items: items.map((i) => ({
    productId: i.product_id,
    productName: i.product_name,
    productSlug: i.product_slug,
    unitPrice: Number(i.unit_price),
    quantity: i.quantity,
    totalPrice: Number(i.total_price),
  })),
  paymentExpiresAt: order.payment_expires_at,
  createdAt: order.created_at,
  ...extra,
});

// ---- duplicate detection --------------------------------------------------------------------
// Two orders are "the same" when items, prices, totals, contact and delivery snapshot all match.
const fingerprint = ({ items, totals, customer, shipping }) =>
  sha256(
    JSON.stringify([
      [...items].sort((a, b) => a.productId.localeCompare(b.productId))
        .map((i) => [i.productId, i.quantity, money(i.unitPrice)]),
      [totals.subtotal, totals.discountAmount, totals.taxAmount, totals.shippingAmount, totals.totalAmount].map(money),
      [customer.email, customer.phone || ''],
      [shipping.firstName, shipping.lastName, shipping.phone, shipping.country.trim(), shipping.addressLine1,
        shipping.addressLine2 || '', shipping.city, shipping.state, shipping.postalCode],
    ])
  );

const fingerprintOfOrder = (o, items) =>
  fingerprint({
    items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity, unitPrice: i.unit_price })),
    totals: {
      subtotal: o.subtotal, discountAmount: o.discount_amount, taxAmount: o.tax_amount,
      shippingAmount: o.shipping_amount, totalAmount: o.total_amount,
    },
    customer: { email: o.customer_email, phone: o.customer_phone },
    shipping: {
      firstName: o.shipping_first_name, lastName: o.shipping_last_name, phone: o.shipping_phone,
      country: o.shipping_country, addressLine1: o.shipping_address_line1,
      addressLine2: o.shipping_address_line2, city: o.shipping_city, state: o.shipping_state,
      postalCode: o.shipping_postal_code,
    },
  });

// ---- checkout context (cart + customer + delivery snapshot) --------------------------------------
const cartUsable = (cart) =>
  cart && cart.status === 'ACTIVE' && (!cart.expires_at || new Date(cart.expires_at) > new Date());

const resolveUser = async (identity, { addressId }) => {
  if (!addressId) throw new AppError(400, 'ADDRESS_REQUIRED', 'addressId is required for authenticated checkout');
  const user = await usersRepository.findById(identity.userId);
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Invalid token');
  const address = await addressRepository.findOwned(addressId, identity.userId);
  if (!address) throw new AppError(404, 'ADDRESS_NOT_FOUND', 'Address not found');
  const cart = await repository.findActiveUserCart(identity.userId);
  return {
    cart,
    owner: { customerType: 'USER', userId: identity.userId, guestSessionId: null },
    customer: { email: user.email, phone: address.phone },
    shipping: {
      firstName: address.first_name, lastName: address.last_name, phone: address.phone,
      country: address.country.trim(), addressLine1: address.address_line1,
      addressLine2: address.address_line2, city: address.city, state: address.state,
      postalCode: address.postal_code,
    },
  };
};

const resolveGuest = async (identity) => {
  const s = identity.session;
  if (!s.anonymous_cart_id) {
    throw new AppError(422, 'GUEST_SESSION_HAS_NO_CART', 'Guest checkout session is not linked to a cart');
  }
  const required = {
    email: s.email, firstName: s.first_name, lastName: s.last_name, phone: s.phone, country: s.country,
    addressLine1: s.address_line1, city: s.city, state: s.state, postalCode: s.postal_code,
  };
  const missing = Object.keys(required).filter((k) => !required[k]);
  if (missing.length) {
    throw new AppError(422, 'CHECKOUT_DETAILS_INCOMPLETE', 'Guest checkout details are incomplete',
      missing.map((field) => ({ field, message: `${field} is required` })));
  }
  const cart = await repository.findCart(s.anonymous_cart_id);
  if (cart && !cart.anonymous_id) throw new AppError(404, 'CART_NOT_FOUND', 'Cart not found');
  return {
    cart,
    owner: { customerType: 'GUEST', userId: null, guestSessionId: s.id },
    customer: { email: s.email, phone: s.phone },
    shipping: {
      firstName: s.first_name, lastName: s.last_name, phone: s.phone, country: s.country.trim(),
      addressLine1: s.address_line1, addressLine2: s.address_line2, city: s.city, state: s.state,
      postalCode: s.postal_code,
    },
  };
};

// Current price/availability always comes from the Product CMS, never from the cart snapshot or client.
const priceCart = async (cartItems) => {
  const products = await Promise.all(cartItems.map((i) => productServiceClient.getProduct(i.product_id)));
  const unavailable = [];
  const lines = cartItems.map((ci, idx) => {
    const p = products[idx];
    if (!p) {
      unavailable.push({ productId: ci.product_id, productName: ci.product_name });
      return null;
    }
    return {
      productId: ci.product_id, productName: p.productName, productSlug: p.productSlug,
      unitPrice: pricing.toMoney(pricing.toMinor(p.unitPrice)), quantity: ci.quantity,
    };
  });
  if (unavailable.length) {
    throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'Some products in the cart are no longer available', unavailable);
  }
  return lines;
};

const cartSignature = (items) =>
  items.map((i) => `${i.product_id}:${i.quantity}`).sort().join('|');

// Ends an open order that is being replaced or has timed out, plus its not-yet-used payment attempts.
const closeOpenOrder = async (order, status, client) => {
  if (await paymentsRepository.hasInFlightAttempt(order.id, client)) {
    throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for the existing order is in progress');
  }
  await paymentsRepository.closeCreatedAttempts(order.id, status === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED',
    status === 'EXPIRED' ? 'ORDER_EXPIRED' : 'ORDER_SUPERSEDED', client);
  await repository.closeOrder(order.id, status, client);
};

// ---- create ------------------------------------------------------------------------------------
const replay = async (order) => ({ order: toView(order, await repository.listItems(order.id)), created: false });

/**
 * identity: req.checkoutIdentity. input: { addressId } (USER only). idempotencyKey: optional header value.
 * Returns { order, created, guestAccessToken? }.
 */
const createOrder = async (identity, input = {}, idempotencyKey) => {
  // Scoped to the caller so another customer's key can never collide with or reveal an order.
  const keyHash = idempotencyKey ? sha256(`${identity.ref}:${idempotencyKey}`) : null;
  if (keyHash) {
    const existing = await repository.findByIdempotencyKey(keyHash);
    if (existing) return replay(existing);
  }

  const ctx = identity.type === 'USER' ? await resolveUser(identity, input) : await resolveGuest(identity);
  if (!cartUsable(ctx.cart)) throw new AppError(404, 'CART_NOT_FOUND', 'No active cart found');

  const cartItems = await repository.listCartItems(ctx.cart.id);
  if (cartItems.length === 0) throw new AppError(422, 'CART_EMPTY', 'Cart is empty');

  const lines = await priceCart(cartItems);
  const totals = pricing.calculateOrder(lines);
  if (totals.totalMinor < 100) {
    throw new AppError(422, 'ORDER_TOTAL_INVALID', 'Order total must be at least 1.00');
  }
  const priced = lines.map((l, i) => ({ ...l, totalPrice: totals.itemTotals[i] }));
  const snapshot = { items: priced, totals, customer: ctx.customer, shipping: ctx.shipping };
  const wanted = fingerprint(snapshot);
  const signature = cartSignature(cartItems);

  const guestToken = ctx.owner.customerType === 'GUEST' ? crypto.randomBytes(32).toString('base64url') : null;

  try {
    return await db.withTransaction(async (client) => {
      // Serialises concurrent checkouts of the same cart.
      const cart = await repository.findCart(ctx.cart.id, { forUpdate: true }, client);
      if (!cartUsable(cart)) throw new AppError(409, 'CART_NOT_ACTIVE', 'Cart is no longer active');
      if (cartSignature(await repository.listCartItems(cart.id, client)) !== signature) {
        throw new AppError(409, 'CART_CHANGED', 'Cart changed while placing the order; please retry');
      }
      if (await repository.hasSettledOrderForCart(cart.id, client)) {
        throw new AppError(409, 'CART_ALREADY_ORDERED', 'This cart has already been paid for');
      }

      const open = await repository.findOpenByCart(cart.id, { forUpdate: true }, client);
      if (open) {
        const stale = open.payment_expires_at && new Date(open.payment_expires_at) <= new Date();
        const items = await repository.listItems(open.id, client);
        if (!stale && fingerprintOfOrder(open, items) === wanted) {
          return { order: toView(open, items), created: false };
        }
        await closeOpenOrder(open, stale ? 'EXPIRED' : 'CANCELLED', client);
      }

      const order = await repository.insertOrder(
        {
          ...ctx.owner,
          guestAccessTokenHash: guestToken ? sha256(guestToken) : null,
          cartId: cart.id,
          idempotencyKey: keyHash,
          totals,
          customer: ctx.customer,
          shipping: ctx.shipping,
          paymentExpiresAt: new Date(Date.now() + env.checkout.paymentWindowMinutes * 60 * 1000),
        },
        client
      );
      const items = [];
      for (const l of priced) {
        items.push(await repository.insertItem(order.id, l, client));
      }
      return {
        order: toView(order, items, guestToken ? { guestAccessToken: guestToken } : {}),
        created: true,
      };
    });
  } catch (err) {
    // Lost a race on a unique index: return the winner instead of failing.
    if (err.code === '23505') {
      const winner =
        (keyHash && (await repository.findByIdempotencyKey(keyHash))) ||
        (await repository.findOpenByCart(ctx.cart.id));
      if (winner) return replay(winner);
    }
    console.log(err);
    throw err;
  }
};

// ---- access (shared with the payments module) --------------------------------------------------------
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const canAccess = (order, identity) => {
  if (identity.type === 'USER') return order.customer_type === 'USER' && order.user_id === identity.userId;
  if (identity.session) return order.customer_type === 'GUEST' && order.guest_session_id === identity.session.id;
  return (
    order.customer_type === 'GUEST' &&
    !!order.guest_access_token_hash &&
    safeEqual(order.guest_access_token_hash, identity.orderTokenHash)
  );
};

module.exports = { createOrder, canAccess, toView, fingerprint, fingerprintOfOrder };
