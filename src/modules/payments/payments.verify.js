'use strict';

const crypto = require('crypto');
const db = require('../../config/database');
const repository = require('./payments.repository');
const orderRepository = require('../orders/orders.repository');
const { applyGatewayPayment } = require('./payments.settlement');
const { canAccess } = require('../orders/orders.service');
const { toMinor } = require('../orders/orders.pricing');
const razorpay = require('../../integrations/razorpay');
const { AppError } = require('../../utils/errors');

const SUCCESS = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

const view = (payment, order, extra) => ({
  paymentId: payment.id,
  orderId: order.id,
  orderNumber: order.order_number,
  razorpayOrderId: payment.razorpay_order_id,
  razorpayPaymentId: payment.razorpay_payment_id,
  paymentStatus: payment.status,
  orderStatus: order.status,
  paid: order.status === 'PAID' && SUCCESS.includes(payment.status),
  amount: toMinor(payment.amount),
  currency: payment.currency.trim(),
  ...extra,
});

// Audit entry for a rejected request; written outside the business transaction so it always persists.
const audit = (paymentId, amount, currency, errorCode, material) =>
  repository.insertTransaction({
    paymentId, type: 'FAILURE', status: 'FAILED', amount, currency: currency.trim(),
    idempotencyKey: `reject:${errorCode}:${paymentId}:${sha(material).slice(0, 24)}`,
    source: 'CLIENT', errorCode,
  });

/**
 * Verifies a checkout result. Nothing the browser says is trusted: the signature is checked against our
 * secret, then payment status/amount/order are read directly from Razorpay while the order+payment rows are
 * locked. Repeating a request is safe: settled payments return the stored result without another gateway call.
 *
 * Returns { payment, alreadyProcessed } on success (paid, or accepted-but-not-yet-captured with paid=false).
 */
const verifyPayment = async (identity, input) => {
  razorpay.getKeyId(); // 503 when the gateway is not configured

  // 1. Resolve the internal payment. Unknown and not-yours are indistinguishable.
  const known = await repository.findById(input.internalPaymentId);
  const knownOrder = known && (await orderRepository.findById(known.order_id));
  if (!known || !knownOrder || !canAccess(knownOrder, identity)) {
    throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  }

  // 2. The Razorpay order must be the one we created for this payment.
  if (input.razorpay_order_id !== known.razorpay_order_id) {
    await audit(known.id, known.amount, known.currency, 'RAZORPAY_ORDER_MISMATCH', input.razorpay_order_id + input.razorpay_payment_id);
    throw new AppError(400, 'RAZORPAY_ORDER_MISMATCH', 'Razorpay order does not match this payment');
  }

  // 3. HMAC-SHA256 signature.
  const signatureOk = razorpay.verifySignature({
    razorpayOrderId: input.razorpay_order_id,
    razorpayPaymentId: input.razorpay_payment_id,
    signature: input.razorpay_signature,
  });
  if (!signatureOk) {
    await audit(known.id, known.amount, known.currency, 'INVALID_SIGNATURE', input.razorpay_payment_id + input.razorpay_signature);
    throw new AppError(400, 'INVALID_SIGNATURE', 'Payment signature is invalid');
  }

  // 4. Authoritative state, under row locks (order first, then payment - the create-order lock order).
  let result;
  try {
    result = await db.withTransaction(async (client) => {
      // Lock order: cart -> order -> payment (same as order creation), so concurrent flows cannot deadlock.
      if (knownOrder.cart_id) await orderRepository.findCart(knownOrder.cart_id, { forUpdate: true }, client);
      const order = await orderRepository.findById(known.order_id, { forUpdate: true }, client);
      const payment = await repository.findById(known.id, { forUpdate: true }, client);

      if (SUCCESS.includes(payment.status)) {
        if (payment.razorpay_payment_id === input.razorpay_payment_id) {
          return { payment: view(payment, order, { alreadyProcessed: true }) };
        }
        throw new AppError(409, 'PAYMENT_ALREADY_PROCESSED', 'This payment was already settled with a different Razorpay payment');
      }

      const gw = await razorpay.fetchPayment(input.razorpay_payment_id);
      if (gw.orderId !== payment.razorpay_order_id || gw.amount !== toMinor(payment.amount) ||
          String(gw.currency).toUpperCase() !== payment.currency.trim()) {
        // Signature was valid yet details disagree: never mark paid. (Logged; rolled back with the throw.)
        console.error(JSON.stringify({ level: 'error', message: 'Gateway payment mismatch', paymentId: payment.id, razorpayPaymentId: gw.id }));
        throw new AppError(409, 'PAYMENT_MISMATCH', 'Payment details do not match the order');
      }

      const applied = await applyGatewayPayment(client, { order, payment, gw, source: 'CLIENT' });
      if (applied.error) return { error: applied.error };
      return { payment: view(applied.payment, applied.order, { alreadyProcessed: false }) };
    });
  } catch (err) {
    // A reopened FAILED payment collided with a newer open attempt.
    if (err.code === '23505') throw new AppError(409, 'PAYMENT_CONFLICT', 'A newer payment attempt exists for this order');
    throw err;
  }

  if (result.error) throw result.error;
  return result.payment;
};

module.exports = { verifyPayment };
