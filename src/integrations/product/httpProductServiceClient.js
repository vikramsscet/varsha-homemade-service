'use strict';

const Joi = require('joi');
const { AppError } = require('../../utils/errors');

const CART_CURRENCY = 'INR';

// Product CMS contract: GET {baseUrl}/api/v1/products/{id} (see {baseUrl}/api-docs).
// The docs list OAuth2 (products:read) but the endpoint is currently public; add a client-credentials
// token here if the CMS starts enforcing it.
const productSchema = Joi.object({
  id: Joi.string().guid().required(),
  title: Joi.string().max(255).required(),
  slug: Joi.string().max(255).required(),
  price: Joi.alternatives(Joi.number().min(0), Joi.string().pattern(/^\d+(\.\d{1,2})?$/)).required(),
  currency: Joi.string().required(),
  status: Joi.string().required(),
  isAvailable: Joi.boolean().required(),
}).unknown(true);

class HttpProductServiceClient {
  constructor({ baseUrl, timeoutMs }) {
    if (!baseUrl) throw new Error('PRODUCT_SERVICE_URL is required when PRODUCT_SERVICE_PROVIDER=http');
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  // Returns { productId, productName, productSlug, unitPrice }, or null if the product does not exist
  // or cannot be sold (not PUBLISHED, or unavailable). Throws 422 for a non-INR product.
  async getProduct(productId) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/products/${encodeURIComponent(productId)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AppError(502, 'PRODUCT_SERVICE_UNAVAILABLE', 'Product service unavailable');
    }
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) {
      throw new AppError(502, 'PRODUCT_SERVICE_UNAVAILABLE', 'Product service unavailable');
    }

    const { value, error } = productSchema.validate(await res.json().catch(() => null), {
      stripUnknown: true,
    });
    if (error) {
      throw new AppError(502, 'PRODUCT_SERVICE_INVALID_RESPONSE', 'Product service returned an invalid response');
    }

    if (value.status !== 'PUBLISHED' || !value.isAvailable) return null;
    if (value.currency.toUpperCase() !== CART_CURRENCY) {
      throw new AppError(422, 'PRODUCT_CURRENCY_UNSUPPORTED', `Only ${CART_CURRENCY} products can be added to the cart`);
    }
    return {
      productId: value.id,
      productName: value.title,
      productSlug: value.slug,
      unitPrice: String(value.price),
    };
  }
}

module.exports = { HttpProductServiceClient };
