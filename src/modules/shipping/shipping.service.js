'use strict';

const env = require('../../config/env');
const { cartService } = require('../cart');
const { productServiceClient } = require('../../integrations/product');
const shiprocket = require('../../integrations/shiprocket');
const { buildPackage } = require('./shipping.package');
const { AppError } = require('../../utils/errors');

const MESSAGES = {
  yes: 'Delivery is available at your location',
  no: 'Currently, delivery is unavailable at this PIN code',
};

// Shared by both APIs: validates config, loads the caller's cart, builds the package server-side and
// returns the Shiprocket query. Never creates orders/shipments.
const buildQuery = async (owner, { deliveryPincode, paymentMethod }) => {
  const pickupPincode = env.shiprocket.pickupPincode;
  if (!/^\d{6}$/.test(pickupPincode || '')) {
    throw new AppError(503, 'SHIPPING_NOT_CONFIGURED', 'Shipping service is not configured');
  }

  const cart = await cartService.getCurrentCart(owner);
  if (!cart.items.length) throw new AppError(422, 'CART_EMPTY', 'Cart is empty');

  const lines = await Promise.all(
    cart.items.map(async (item) => ({
      productId: item.productId,
      quantity: item.quantity,
      info: await productServiceClient.getPackageInfo(item.productId),
    }))
  );
  const pkg = buildPackage(lines, { packagingWeightGrams: env.shipping.packagingWeightGrams });

  return {
    pickupPincode,
    query: {
      pickupPostcode: pickupPincode,
      deliveryPostcode: deliveryPincode,
      cod: paymentMethod === 'COD' ? 1 : 0,
      weight: pkg.weightKg,
      length: pkg.lengthCm,
      breadth: pkg.breadthCm,
      height: pkg.heightCm,
      declaredValue: cart.subtotal,
    },
  };
};

/**
 * Checks whether the caller's current cart can be delivered to a PIN code. Read-only.
 * owner is { userId } | { anonymousId } (from cartIdentity).
 */
const checkServiceability = async (owner, input) => {
  const { pickupPincode, query } = await buildQuery(owner, input);
  const { serviceable } = await shiprocket.checkServiceability(query);
  const { deliveryPincode } = input;
  return serviceable
    ? { serviceable: true, deliveryPincode, pickupPincode, message: MESSAGES.yes }
    : { serviceable: false, deliveryPincode, message: MESSAGES.no };
};

// Hook for future business pricing (free-shipping threshold, flat rate, local delivery, packaging fee).
// Today it returns Shiprocket's charges untouched.
const applyPricingRules = (options) => options;

/** Shipping options (cheapest first) for the caller's cart. Read-only: no order, AWB or pickup. */
const getRates = async (owner, input) => {
  const { query } = await buildQuery(owner, input);
  const options = applyPricingRules(await shiprocket.getRates(query));
  return {
    deliveryPincode: input.deliveryPincode,
    serviceable: options.length > 0,
    currency: 'INR',
    shippingOptions: options,
  };
};

module.exports = { checkServiceability, getRates };
