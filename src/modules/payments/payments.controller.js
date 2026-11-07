'use strict';

const service = require('./payments.service');
const { handleWebhook } = require('./payments.webhook');
const { AppError } = require('../../utils/errors');
const { success } = require('../../utils/response');

const createOrder = async (req, res, next) => {
  try {
    const { payment, created } = await service.createPaymentOrder(req.checkoutIdentity, req.body.orderId.toLowerCase());
    res.set('Cache-Control', 'no-store');
    return success(res, payment, created ? 'Payment order created' : 'Existing payment order returned', created ? 201 : 200);
  } catch (err) {
    return next(err);
  }
};

const verify = async (req, res, next) => {
  try {
    const b = { ...req.body, internalPaymentId: req.body.internalPaymentId.toLowerCase() };
    const payment = await service.verifyPayment(req.checkoutIdentity, b);
    res.set('Cache-Control', 'no-store');
    if (payment.paid) {
      return success(res, payment, payment.alreadyProcessed ? 'Payment already verified' : 'Payment verified', 200);
    }
    // Signature valid but Razorpay has not captured the money yet: accepted, not paid.
    return success(res, payment, 'Payment received but not captured yet', 202);
  } catch (err) {
    return next(err);
  }
};

// Server-to-server: no checkout identity. Authenticity is the HMAC over the raw body.
const webhook = async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'Empty webhook body');
    }
    const out = await handleWebhook({
      rawBody: req.body,
      signature: req.get('x-razorpay-signature'),
      eventIdHeader: req.get('x-razorpay-event-id'),
    });
    return success(res, out.body, 'Webhook received', out.status);
  } catch (err) {
    return next(err);
  }
};

module.exports = { createOrder, verify, webhook };
