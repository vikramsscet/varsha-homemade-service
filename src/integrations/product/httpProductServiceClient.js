'use strict';

const Joi = require('joi');
const { AppError } = require('../../utils/errors');

// Contract we expect from the Product CMS (adjust the mapping here when the real API is known).
const productSchema = Joi.object({
  productId: Joi.string().guid().required(),
  productName: Joi.string().max(255).required(),
  productSlug: Joi.string().max(255).required(),
  unitPrice: Joi.alternatives(Joi.number().min(0), Joi.string().pattern(/^\d+(\.\d{1,2})?$/)).required(),
}).unknown(true);

class HttpProductServiceClient {
  constructor({ baseUrl, timeoutMs }) {
    if (!baseUrl) throw new Error('PRODUCT_SERVICE_URL is required when PRODUCT_SERVICE_PROVIDER=http');
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  // Returns { productId, productName, productSlug, unitPrice } or null if the product does not exist.
  async getProduct(productId) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/products/${encodeURIComponent(productId)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AppError(502, 'PRODUCT_SERVICE_UNAVAILABLE', 'Product service unavailable');
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new AppError(502, 'PRODUCT_SERVICE_UNAVAILABLE', 'Product service unavailable');
    }

    const { value, error } = productSchema.validate(await res.json().catch(() => null), {
      stripUnknown: true,
    });
    if (error) {
      throw new AppError(502, 'PRODUCT_SERVICE_INVALID_RESPONSE', 'Product service returned an invalid response');
    }
    return { ...value, unitPrice: String(value.unitPrice) };
  }
}

module.exports = { HttpProductServiceClient };
