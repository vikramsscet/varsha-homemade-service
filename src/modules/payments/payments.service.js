'use strict';

const crypto = require('crypto');
const db = require('../../config/database');
const repository = require('./payments.repository');
const orderRepository = require('../orders/orders.repository');
const { canAccess } = require('../orders/orders.service');
const razorpay = require('../../integrations/razorpay');
const { toMinor } = require('../orders/orders.pricing');
const { AppError } = require('../../utils/errors');

const toView = (payment, order, extra) => ({
  orderId: order.id,
  paymentId: payment.id,
  attemptNumber: payment.attempt_number,
  razorpayOrderId: payment.razorpay_order_id,
  razorpayKeyId: razorpay.getKeyId(),
  amount: toMinor(payment.amount), // paise
  currency: payment.currency.trim(),
  status: payment.status,
  ...extra,
});

/**
 * Creates (or returns the in-flight) Razorpay order for an internal order the caller owns.
 * The amount is ALWAYS taken from the stored order total. Returns { payment, created }.
 *
 * The order row is locked for the whole call, so concurrent requests for one order are serialised:
 * the second sees the first attempt and reuses it instead of creating another Razorpay order.
 * (A Razorpay order created right before a failed DB write is an unpaid, harmless orphan; its id is logged.)
 */
const createPaymentOrder = async (identity, orderId) => {
  razorpay.getKeyId(); // fail fast with 503 before touching the database when unconfigured

  return db.withTransaction(async (client) => {
    const order = await orderRepository.findById(orderId, { forUpdate: true }, client);
    // Not-yours and not-found are indistinguishable.
    if (!order || !canAccess(order, identity)) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');

    if (['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.status) ||
        (await repository.hasSuccessfulPayment(order.id, client))) {
      throw new AppError(409, 'ORDER_ALREADY_PAID', 'Order has already been paid');
    }
    if (!['PENDING_PAYMENT', 'PAYMENT_FAILED'].includes(order.status)) {
      throw new AppError(409, 'ORDER_NOT_PAYABLE', `Order is ${order.status.toLowerCase()} and cannot be paid`);
    }
    if (order.payment_expires_at && new Date(order.payment_expires_at) <= new Date()) {
      throw new AppError(409, 'ORDER_EXPIRED', 'Payment window for this order has expired');
    }

    const open = await repository.findOpenByOrder(order.id, client);
    if (open) {
      if (open.status === 'AUTHORIZED') {
        throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this order is already in progress');
      }
      return { payment: toView(open, order, { reused: true }), created: false };
    }

    const attemptNumber = await repository.nextAttemptNumber(order.id, client);
    const paymentId = crypto.randomUUID();
    const amountPaise = toMinor(order.total_amount);
    const currency = order.currency.trim();

    const rzp = await razorpay.createOrder({
      amount: amountPaise,
      currency,
      receipt: `${order.order_number}-${attemptNumber}`.slice(0, 40),
      notes: { internalOrderId: order.id, internalPaymentId: paymentId, orderNumber: order.order_number },
    });
    if (rzp.amount !== amountPaise || String(rzp.currency).toUpperCase() !== currency) {
      console.error(JSON.stringify({ level: 'error', message: 'Razorpay order mismatch', razorpayOrderId: rzp.id }));
      throw new AppError(502, 'PAYMENT_GATEWAY_INVALID_RESPONSE', 'Payment gateway returned an invalid response');
    }

    try {
      const payment = await repository.insert(
        { id: paymentId, orderId: order.id, attemptNumber, razorpayOrderId: rzp.id, currency, amount: order.total_amount },
        client
      );
      await repository.insertTransaction(
        {
          paymentId, type: 'ATTEMPT', status: 'PENDING', amount: order.total_amount, currency,
          idempotencyKey: `attempt:${rzp.id}`, source: 'API',
          gatewayResponse: { id: rzp.id, amount: rzp.amount, currency: rzp.currency, status: rzp.status, receipt: rzp.receipt },
        },
        client
      );
      return { payment: toView(payment, order, { reused: false }), created: true };
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: 'Persisting payment failed', razorpayOrderId: rzp.id, orderId: order.id }));
      throw err;
    }
  });
};

module.exports = { createPaymentOrder, verifyPayment: require('./payments.verify').verifyPayment };
