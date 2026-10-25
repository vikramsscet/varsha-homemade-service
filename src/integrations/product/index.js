'use strict';

const env = require('../../config/env');
const { MockProductServiceClient } = require('./mockProductServiceClient');
const { HttpProductServiceClient } = require('./httpProductServiceClient');

/**
 * ProductServiceClient contract (the only thing the Cart module depends on):
 *   getProduct(productId: string): Promise<{ productId, productName, productSlug, unitPrice } | null>
 * Resolves null when the product does not exist; throws AppError(502) when the Product CMS fails.
 */
const create = () => {
  if (env.productService.provider === 'http') {
    return new HttpProductServiceClient(env.productService);
  }
  if (env.isProduction) {
    throw new Error('PRODUCT_SERVICE_PROVIDER=mock is not allowed in production');
  }
  return new MockProductServiceClient();
};

module.exports = { productServiceClient: create(), create };
