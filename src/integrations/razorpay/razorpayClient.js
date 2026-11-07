'use strict';

const crypto = require('crypto');
const { AppError } = require('../../utils/errors');
const { extractInstrument } = require('../../modules/payments/payments.instrument');

const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]+$/;

/**
 * Minimal Razorpay Orders API client (server-side only). Credentials are read from config at
 * construction and are never logged, returned to callers or persisted.
 */
class RazorpayClient {
  constructor({ keyId, keySecret, webhookSecret = '', baseUrl, timeoutMs }) {
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  assertConfigured() {
    if (!this.keyId || !this.keySecret || !KEY_ID_PATTERN.test(this.keyId)) {
      throw new AppError(503, 'PAYMENT_GATEWAY_NOT_CONFIGURED', 'Payment gateway is not configured');
    }
  }

  /**
   * Checkout signature check: HMAC-SHA256(`${razorpayOrderId}|${razorpayPaymentId}`, keySecret) as hex,
   * compared in constant time. The secret never leaves this class.
   */
  verifySignature({ razorpayOrderId, razorpayPaymentId, signature }) {
    this.assertConfigured();
    if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }

  /**
   * Webhook signature: HMAC-SHA256(raw request body bytes, webhook secret) as hex, from X-Razorpay-Signature.
   * Must be computed over the exact bytes received (never over re-serialised JSON). Constant-time compare.
   * Throws 503 when no webhook secret is configured (so Razorpay keeps retrying instead of dropping events).
   */
  verifyWebhookSignature(rawBody, signature) {
    if (!this.webhookSecret) {
      throw new AppError(503, 'PAYMENT_WEBHOOK_NOT_CONFIGURED', 'Payment webhook is not configured');
    }
    if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }

  // Fetches the authoritative payment from Razorpay. Returns only a whitelist of fields (no card/contact PII).
  async fetchPayment(paymentId) {
    this.assertConfigured();
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: 'Razorpay payment fetch failed', reason: err.name }));
      throw new AppError(502, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway unavailable');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        JSON.stringify({ level: 'error', message: 'Razorpay rejected payment fetch', status: res.status,
          code: body && body.error && body.error.code })
      );
      throw new AppError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment gateway error');
    }
    if (!body || body.id !== paymentId || typeof body.status !== 'string' || !Number.isInteger(body.amount)) {
      throw new AppError(502, 'PAYMENT_GATEWAY_INVALID_RESPONSE', 'Payment gateway returned an invalid response');
    }
    return {
      id: body.id,
      orderId: body.order_id || null,
      status: body.status,
      amount: body.amount,
      currency: body.currency,
      method: body.method || null,
      instrument: extractInstrument(body), // display-only; card number/CVV/full VPA are never read
      captured: body.captured === true,
      errorCode: body.error_code || null,
      errorDescription: body.error_description || null,
    };
  }

  // amount is an integer in paise. Resolves the Razorpay order object ({ id, amount, currency, status, receipt }).
  async createOrder({ amount, currency, receipt, notes }) {
    this.assertConfigured();
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ amount, currency, receipt, notes }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: 'Razorpay request failed', reason: err.name }));
      throw new AppError(502, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway unavailable');
    }

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // Log status + Razorpay error code only (no request headers, no credentials).
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Razorpay rejected order creation',
          status: res.status,
          code: body && body.error && body.error.code,
        })
      );
      throw new AppError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment gateway error');
    }
    if (!body || typeof body.id !== 'string' || !/^order_/.test(body.id)) {
      throw new AppError(502, 'PAYMENT_GATEWAY_INVALID_RESPONSE', 'Payment gateway returned an invalid response');
    }
    return {
      id: body.id,
      amount: body.amount,
      currency: body.currency,
      status: body.status,
      receipt: body.receipt,
    };
  }
}

module.exports = { RazorpayClient, KEY_ID_PATTERN };
