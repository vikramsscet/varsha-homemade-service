'use strict';

// The single payment state machine. Both POST /payments/verify (source CLIENT, data fetched from Razorpay)
// and POST /payments/webhook (source WEBHOOK, data from a signed event) call applyGatewayPayment inside a
// transaction that already holds the cart -> order -> payment row locks.
//
// Transitions are monotonic and enforced in SQL (see payments.repository mark*): a late or replayed
// event can never move a settled payment backwards. Ledger rows use deterministic idempotency keys
// (capture:<pay_id> ...), so the same fact arriving via verify AND webhook is recorded once.

const repository = require('./payments.repository');
const orderRepository = require('../orders/orders.repository');
const cartRepository = require('../cart/cart.repository');
const { AppError } = require('../../utils/errors');

const SUCCESS = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const ORDER_SETTLED = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const PAYABLE = ['PENDING_PAYMENT', 'PAYMENT_FAILED'];

// Non-secret subset of the gateway payment kept in the audit ledger.
const snapshot = (d) => ({
  id: d.id, order_id: d.orderId, status: d.status, amount: d.amount, currency: d.currency,
  method: d.method, captured: d.captured,
});

/**
 * gw: { id, orderId, status: 'captured'|'authorized'|'failed'|'refunded'|'created', amount, currency, method,
 *       captured, errorCode, errorDescription }
 * Returns { kind, payment, order, error?, reason? }
 *   kind CAPTURED | AUTHORIZED | PENDING | FAILED  - a real transition (or its idempotent replay)
 *   kind NOOP                                      - stale/duplicate event, nothing changed (reason says why)
 *   kind REJECTED                                  - cannot be applied (reason/error); money may need a refund
 */
const applyGatewayPayment = async (client, { order, payment, gw, source, webhookEventId }) => {
  const settled = (await repository.hasSuccessfulPayment(order.id, client)) || ORDER_SETTLED.includes(order.status);
  const payable = PAYABLE.includes(order.status);
  const base = {
    paymentId: payment.id, amount: payment.amount, currency: payment.currency.trim(), source,
    webhookEventId: webhookEventId || null, gatewayResponse: snapshot(gw),
  };
  const record = (type, status, key, errorCode) =>
    repository.insertTransaction({ ...base, type, status, idempotencyKey: key, errorCode }, client);
  const result = (kind, extra = {}) => ({ kind, payment, order, ...extra });

  switch (gw.status) {
    case 'captured': {
      if (SUCCESS.includes(payment.status)) {
        if (payment.razorpay_payment_id === gw.id) return result('NOOP', { reason: 'DUPLICATE_EVENT' });
        // A second Razorpay payment was captured for an already-settled attempt: customer was charged twice.
        await record('CAPTURE', 'SUCCESS', `capture:${gw.id}`, 'DUPLICATE_CAPTURE');
        return result('REJECTED', { reason: 'DUPLICATE_CAPTURE',
          error: new AppError(409, 'PAYMENT_ALREADY_PROCESSED', 'This payment was already settled with a different Razorpay payment') });
      }
      if (settled || !payable) {
        const reason = settled ? 'ORDER_ALREADY_PAID' : 'ORDER_NOT_PAYABLE';
        await record('CAPTURE', 'SUCCESS', `capture:${gw.id}`, reason); // captured money to refund
        return result('REJECTED', { reason, error: settled
          ? new AppError(409, 'ORDER_ALREADY_PAID', 'Order has already been paid')
          : new AppError(409, 'ORDER_NOT_PAYABLE', `Order is ${order.status.toLowerCase()} and cannot be paid`) });
      }
      const captured = await repository.markCaptured(payment.id, gw, client);
      if (!captured) throw new AppError(409, 'PAYMENT_NOT_VERIFIABLE', `Payment is ${payment.status.toLowerCase()} and cannot be verified`);
      const paid = await orderRepository.markPaid(order.id, client); // WHERE confirmed_at IS NULL
      if (!paid) throw new AppError(409, 'ORDER_NOT_PAYABLE', 'Order could not be confirmed');
      if (order.cart_id) await cartRepository.setStatus(order.cart_id, 'COMPLETED', client);
      await record('CAPTURE', 'SUCCESS', `capture:${gw.id}`);
      return { kind: 'CAPTURED', payment: captured, order: paid };
    }

    case 'authorized': {
      if (SUCCESS.includes(payment.status)) {
        await record('AUTHORIZATION', 'SUCCESS', `auth:${gw.id}`); // arrived after capture: history only
        return result('NOOP', { reason: 'STALE_EVENT' });
      }
      if (settled || !payable) return result('REJECTED', { reason: settled ? 'ORDER_ALREADY_PAID' : 'ORDER_NOT_PAYABLE',
        error: new AppError(409, settled ? 'ORDER_ALREADY_PAID' : 'ORDER_NOT_PAYABLE', 'Order cannot take this payment') });
      const updated = await repository.markAuthorized(payment.id, gw, client);
      await record('AUTHORIZATION', 'SUCCESS', `auth:${gw.id}`);
      return { kind: 'AUTHORIZED', payment: updated || payment, order, ...(updated ? {} : { reason: 'STALE_EVENT' }) };
    }

    case 'failed': {
      const err = new AppError(402, 'PAYMENT_FAILED', 'Payment failed',
        { reason: gw.errorDescription || undefined, code: gw.errorCode || undefined });
      await record('FAILURE', 'FAILED', `failure:${gw.id}`, (gw.errorCode || 'PAYMENT_FAILED').slice(0, 100));
      // A failure of an earlier attempt must not undo a capture, nor another payment's authorization.
      const otherLive = payment.status === 'AUTHORIZED' && payment.razorpay_payment_id && payment.razorpay_payment_id !== gw.id;
      if (SUCCESS.includes(payment.status) || otherLive) return result('NOOP', { reason: 'STALE_EVENT', error: err });
      const failed = await repository.markFailed(payment.id, gw, client);
      await orderRepository.markPaymentFailed(order.id, client);
      return { kind: 'FAILED', payment: failed || payment, order, error: err };
    }

    case 'refunded':
      return result('REJECTED', { reason: 'PAYMENT_REFUNDED', error: new AppError(409, 'PAYMENT_REFUNDED', 'Payment has been refunded') });

    default: {
      // 'created': checkout opened but no completed payment yet.
      const pending = await repository.markPending(payment.id, gw.id, client);
      await record('ATTEMPT', 'PENDING', `pending:${gw.id}`);
      return { kind: 'PENDING', payment: pending || payment, order };
    }
  }
};

module.exports = { applyGatewayPayment, SUCCESS };
