'use strict';

const { AppError } = require('../../utils/errors');

const log = (message, extra) =>
  // Status codes / reasons only: never tokens, credentials, request URLs (they contain PIN codes) or bodies.
  console.error(JSON.stringify({ level: 'error', message, ...extra }));

const toNumber = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

// Delivery date only when Shiprocket gives a parseable ETD; never guessed from the day count.
const toIsoDate = (etd) => {
  if (typeof etd !== 'string' || !etd.trim()) return null;
  const d = new Date(`${etd.trim()} 00:00:00 UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const normalizeCouriers = (couriers) =>
  couriers
    .filter((c) => c && !Number(c.blocked)) // blocked = cannot deliver to this destination
    .map((c) => {
      const days = toNumber(c.estimated_delivery_days);
      return {
        provider: 'SHIPROCKET',
        courierId: toNumber(c.courier_company_id),
        courierName: typeof c.courier_name === 'string' ? c.courier_name : null,
        shippingCharge: toNumber(c.rate),
        estimatedDeliveryDays: Number.isFinite(days) && days > 0 ? days : null,
        estimatedDeliveryDate: toIsoDate(c.etd),
      };
    })
    .filter((o) => Number.isFinite(o.courierId) && o.courierName && Number.isFinite(o.shippingCharge) && o.shippingCharge >= 0)
    .sort((a, b) => a.shippingCharge - b.shippingCharge);

/**
 * Minimal Shiprocket client (server-side only). Handles authentication centrally: the bearer token is
 * cached in memory, refreshed shortly before expiry or once on a 401, and never leaves this class.
 * Only checks serviceability - it never creates orders or shipments.
 */
class ShiprocketClient {
  constructor({ baseUrl, email, password, timeoutMs = 8000, tokenTtlMs = 9 * 24 * 60 * 60 * 1000 }) {
    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.tokenTtlMs = tokenTtlMs; // Shiprocket tokens last 10 days; renew a day early
    this.token = null;
    this.tokenExpiresAt = 0;
    this.loginInFlight = null;
  }

  assertConfigured() {
    if (!this.baseUrl || !this.email || !this.password) {
      throw new AppError(503, 'SHIPPING_NOT_CONFIGURED', 'Shipping service is not configured');
    }
  }

  // fetch with timeout; maps network failures/timeouts to AppErrors.
  async request(path, options, what) {
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...options, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      log(`Shiprocket ${what} failed`, { reason: timedOut ? 'timeout' : (err && err.name) || 'network' });
      throw timedOut
        ? new AppError(504, 'SHIPPING_PROVIDER_TIMEOUT', 'Shipping service timed out')
        : new AppError(502, 'SHIPPING_PROVIDER_UNAVAILABLE', 'Shipping service unavailable');
    }
  }

  async login() {
    const res = await this.request(
      '/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password }),
      },
      'login'
    );
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.token !== 'string' || !body.token) {
      log('Shiprocket authentication failed', { status: res.status });
      throw new AppError(502, 'SHIPPING_PROVIDER_AUTH_FAILED', 'Shipping service authentication failed');
    }
    return body.token;
  }

  // Single-flight: concurrent callers share one login request.
  async getToken(forceRefresh = false) {
    this.assertConfigured();
    if (!forceRefresh && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login()
        .then((token) => {
          this.token = token;
          this.tokenExpiresAt = Date.now() + this.tokenTtlMs;
          return token;
        })
        .finally(() => {
          this.loginInFlight = null;
        });
    }
    return this.loginInFlight;
  }

  /**
   * GET /courier/serviceability/ -> the raw courier list ([] when the PIN code is not served).
   * Internal: callers must normalize it; the raw payload never leaves the integration layer.
   */
  async fetchCouriers({ pickupPostcode, deliveryPostcode, cod, weight, length, breadth, height, declaredValue }) {
    const query = new URLSearchParams();
    const add = (k, v) => v !== undefined && v !== null && query.set(k, String(v));
    add('pickup_postcode', pickupPostcode);
    add('delivery_postcode', deliveryPostcode);
    add('cod', cod);
    add('weight', weight);
    add('length', length);
    add('breadth', breadth);
    add('height', height);
    add('declared_value', declaredValue);

    const call = async (token) =>
      this.request(
        `/courier/serviceability/?${query.toString()}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
        'serviceability check'
      );

    let res = await call(await this.getToken());
    if (res.status === 401) {
      // Token expired/revoked early: refresh once and retry.
      res = await call(await this.getToken(true));
      if (res.status === 401) {
        log('Shiprocket rejected refreshed token', { status: 401 });
        throw new AppError(502, 'SHIPPING_PROVIDER_AUTH_FAILED', 'Shipping service authentication failed');
      }
    }

    const body = await res.json().catch(() => null);

    // Shiprocket answers 404 ("no courier serviceability") for PIN codes it cannot serve.
    if (res.status === 404) return [];
    if (!res.ok) {
      log('Shiprocket rejected serviceability check', { status: res.status });
      throw new AppError(502, 'SHIPPING_PROVIDER_ERROR', 'Shipping service error');
    }
    if (body && body.status === 404) return [];

    const couriers = body && body.data && body.data.available_courier_companies;
    if (!Array.isArray(couriers)) {
      log('Shiprocket returned an unexpected serviceability response', { status: res.status });
      throw new AppError(502, 'SHIPPING_PROVIDER_INVALID_RESPONSE', 'Shipping service returned an invalid response');
    }
    return couriers;
  }

  // { serviceable, courierCount } for the serviceability API.
  async checkServiceability(params) {
    const couriers = await this.fetchCouriers(params);
    return { serviceable: couriers.length > 0, courierCount: couriers.length };
  }

  /**
   * Normalized, serviceable courier options sorted by charge (lowest first). The charge is Shiprocket's
   * own `rate` (freight + COD + other charges) - nothing is added or recalculated here.
   */
  async getRates(params) {
    return normalizeCouriers(await this.fetchCouriers(params));
  }
}

module.exports = { ShiprocketClient, normalizeCouriers };
