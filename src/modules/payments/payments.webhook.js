'use strict';

const crypto = require('crypto');
const db = require('../../config/database');
const repository = require('./payments.repository');
const events = require('./webhookEvents.repository');
const orderRepository = require('../orders/orders.repository');
const { applyGatewayPayment } = require('./payments.settlement');
const { toMinor } = require('../orders/orders.pricing');
const razorpay = require('../../integrations/razorpay');
const { AppError } = require('../../utils/errors');

// Event -> the payment status that the event announces.
const EVENT_STATUS = {
  'payment.authorized': 'authorized',
  'payment.captured': 'captured',
  'payment.failed': 'failed',
  'order.paid': 'captured',
};
const MAX_ATTEMPTS = 10; // after this many failed deliveries we stop asking Razorpay to retry
const EVENT_ID = /^[A-Za-z0-9_-]{1,100}$/;

const log = (level, message, fields) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ level, message, ...fields }));

// Removes customer PII / instrument details before the payload is stored (audit needs ids, status, amounts).
const PII_KEYS = new Set(['email', 'contact', 'card', 'card_id', 'vpa', 'wallet', 'bank', 'upi', 'acquirer_data',
  'customer_id', 'token_id', 'billing_address', 'international']);
const redact = (v) => {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !PII_KEYS.has(k)).map(([k, x]) => [k, redact(x)]));
  }
  return v;
};

const normalize = (type, entity) => ({
  id: entity.id,
  orderId: entity.order_id || null,
  status: EVENT_STATUS[type],
  amount: entity.amount,
  currency: entity.currency,
  method: entity.method || null,
  captured: EVENT_STATUS[type] === 'captured',
  errorCode: entity.error_code || null,
  errorDescription: entity.error_description || null,
});

const reply = (status, outcome) => ({ status, body: { received: true, status: outcome } });

/**
 * Handles one webhook delivery. Returns { status, body } to send back to Razorpay:
 *   200 processed / ignored / duplicate     -> Razorpay stops retrying
 *   400 bad signature or malformed body     -> rejected, nothing stored
 *   409 same event is being processed       -> Razorpay retries later
 *   500/503 transient failure               -> Razorpay retries (event stays FAILED/RECEIVED, never lost)
 */
const handleWebhook = async ({ rawBody, signature, eventIdHeader }) => {
  // 1. Authenticity first, over the raw bytes. Unauthenticated input is neither stored nor processed.
  if (!razorpay.verifyWebhookSignature(rawBody, signature)) {
    log('warn', 'Razorpay webhook rejected: invalid signature', { bytes: Buffer.isBuffer(rawBody) ? rawBody.length : 0 });
    throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'Malformed webhook body');
  }
  if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
    throw new AppError(400, 'INVALID_WEBHOOK_PAYLOAD', 'Malformed webhook body');
  }

  const type = event.event.slice(0, 60);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const paymentEntity = payload.payment && payload.payment.entity;
  const orderEntity = payload.order && payload.order.entity;
  const refundEntity = payload.refund && payload.refund.entity;
  const razorpayOrderId = (paymentEntity && paymentEntity.order_id) || (orderEntity && orderEntity.id) || null;
  const eventId = EVENT_ID.test(eventIdHeader || '')
    ? eventIdHeader
    : `body:${crypto.createHash('sha256').update(rawBody).digest('hex')}`; // retries of the same body dedupe

  // 2. Persist for audit (idempotent on the Razorpay event id), then decide whether to process.
  let row = await events.insert({
    eventId, eventType: type, razorpayOrderId,
    razorpayPaymentId: (paymentEntity && paymentEntity.id) || null,
    razorpayRefundId: (refundEntity && refundEntity.id) || null,
    payload: redact(event),
  });
  if (!row) {
    row = await events.findByEventId(eventId);
    if (row && ['PROCESSED', 'IGNORED'].includes(row.processing_status)) {
      log('info', 'Razorpay webhook duplicate', { eventId, type, status: row.processing_status });
      return reply(200, 'DUPLICATE');
    }
  }

  // 3. Lease the event so concurrent deliveries of it cannot both process it.
  const claimed = await events.claim(row.id);
  if (!claimed) {
    log('info', 'Razorpay webhook already being processed', { eventId, type });
    return reply(409, 'IN_PROGRESS');
  }
  if (claimed.attempts > MAX_ATTEMPTS) {
    await events.fail(row.id, 'MAX_ATTEMPTS_EXCEEDED');
    log('error', 'Razorpay webhook abandoned after repeated failures', { eventId, type, attempts: claimed.attempts });
    return reply(200, 'ABANDONED');
  }

  // 4. Apply. Any thrown error = transient: record it, answer 500 so Razorpay redelivers.
  try {
    const outcome = await processEvent({ row, type, paymentEntity, orderEntity, razorpayOrderId });
    log('info', 'Razorpay webhook handled', { eventId, type, outcome: outcome.status, reason: outcome.reason, razorpayOrderId });
    return reply(200, outcome.status);
  } catch (err) {
    await events.fail(row.id, err.message).catch(() => {});
    log('error', 'Razorpay webhook processing failed', { eventId, type, attempts: claimed.attempts, error: err.message });
    throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Webhook processing failed, please retry');
  }
};

const processEvent = async ({ row, type, paymentEntity, orderEntity, razorpayOrderId }) => {
  const ignore = async (reason, paymentId) => {
    await events.finish(row.id, 'IGNORED', reason, paymentId);
    return { status: 'IGNORED', reason };
  };

  if (!EVENT_STATUS[type]) return ignore('UNSUPPORTED_EVENT');
  // order.paid carries the captured payment next to the order; all four events need the payment entity.
  if (!paymentEntity || typeof paymentEntity.id !== 'string' || !razorpayOrderId || !Number.isInteger(paymentEntity.amount)) {
    return ignore('MALFORMED_EVENT');
  }
  if (type === 'order.paid' && orderEntity && orderEntity.status && orderEntity.status !== 'paid') {
    return ignore('ORDER_NOT_PAID');
  }
  const gw = normalize(type, paymentEntity);

  const known = await repository.findByRazorpayOrderId(razorpayOrderId);
  if (!known) return ignore('UNKNOWN_PAYMENT'); // not one of ours (e.g. another integration on the account)
  const knownOrder = await orderRepository.findById(known.order_id);

  return db.withTransaction(async (client) => {
    // Same lock order as order creation, verify and create-order: cart -> order -> payment.
    if (knownOrder.cart_id) await orderRepository.findCart(knownOrder.cart_id, { forUpdate: true }, client);
    const order = await orderRepository.findById(known.order_id, { forUpdate: true }, client);
    const payment = await repository.findById(known.id, { forUpdate: true }, client);

    // Signed or not, amounts must agree with what we charged; otherwise never touch state.
    if (gw.amount !== toMinor(payment.amount) || String(gw.currency).toUpperCase() !== payment.currency.trim() ||
        gw.orderId !== payment.razorpay_order_id) {
      log('error', 'Razorpay webhook amount/order mismatch', { paymentId: payment.id, razorpayPaymentId: gw.id });
      await events.finish(row.id, 'IGNORED', 'PAYMENT_MISMATCH', payment.id, client);
      return { status: 'IGNORED', reason: 'PAYMENT_MISMATCH' };
    }

    const applied = await applyGatewayPayment(client, { order, payment, gw, source: 'WEBHOOK', webhookEventId: row.id });
    const changed = ['CAPTURED', 'AUTHORIZED', 'PENDING', 'FAILED'].includes(applied.kind) && !applied.reason;
    const status = changed ? 'PROCESSED' : 'IGNORED';
    await events.finish(row.id, status, changed ? null : applied.reason, payment.id, client);
    if (applied.kind === 'REJECTED' && ['ORDER_ALREADY_PAID', 'ORDER_NOT_PAYABLE', 'DUPLICATE_CAPTURE'].includes(applied.reason)) {
      log('error', 'Captured payment cannot be applied; refund required', { paymentId: payment.id, razorpayPaymentId: gw.id, reason: applied.reason });
    }
    return { status, reason: applied.reason };
  });
};

module.exports = { handleWebhook, redact, MAX_ATTEMPTS };
