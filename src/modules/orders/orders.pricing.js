'use strict';

// Server-side order maths. Everything is integer paise; nothing here ever reads client amounts.
const env = require('../../config/env');

const toMinor = (amount) => Math.round(Number(amount) * 100);
const toMoney = (minor) => (minor / 100).toFixed(2);

// Promotion engine hook. No discounts exist yet, so this is always 0.
const calculateDiscountMinor = () => 0;

/**
 * lines: [{ unitPrice, quantity }] with unitPrice taken from the Product CMS.
 * Returns amounts as NUMERIC-ready strings plus totalMinor (the Razorpay amount in paise).
 */
const calculateOrder = (lines, cfg = env.checkout) => {
  const itemTotals = lines.map((l) => toMinor(l.unitPrice) * l.quantity);
  const subtotal = itemTotals.reduce((a, b) => a + b, 0);
  const discount = Math.min(calculateDiscountMinor(lines, subtotal), subtotal);
  const taxable = subtotal - discount;
  const tax = Math.round((taxable * cfg.taxRatePercent) / 100);
  const waived = cfg.freeShippingThreshold > 0 && taxable >= toMinor(cfg.freeShippingThreshold);
  const shipping = waived ? 0 : toMinor(cfg.shippingFlatFee);
  const total = taxable + tax + shipping;
  return {
    itemTotals: itemTotals.map(toMoney),
    subtotal: toMoney(subtotal),
    discountAmount: toMoney(discount),
    taxAmount: toMoney(tax),
    shippingAmount: toMoney(shipping),
    totalAmount: toMoney(total),
    totalMinor: total,
  };
};

module.exports = { calculateOrder, toMinor, toMoney };
