'use strict';

// Sample catalog for local development and tests. Never used in production.
const CATALOG = [
  {
    productId: '11111111-1111-4111-8111-111111111111',
    productName: 'Homemade Mango Pickle (500g)',
    productSlug: 'homemade-mango-pickle-500g',
    unitPrice: '249.00',
    weightGrams: 550, lengthCm: 10, breadthCm: 10, heightCm: 12,
  },
  {
    productId: '22222222-2222-4222-8222-222222222222',
    productName: 'Besan Laddu (1kg)',
    productSlug: 'besan-laddu-1kg',
    unitPrice: '599.50',
    weightGrams: 1050, lengthCm: 20, breadthCm: 15, heightCm: 10,
  },
  {
    productId: '33333333-3333-4333-8333-333333333333',
    productName: 'Masala Chakli (250g)',
    productSlug: 'masala-chakli-250g',
    unitPrice: '149.99',
    weightGrams: 280, lengthCm: 15, breadthCm: 10, heightCm: 8,
  },
];

class MockProductServiceClient {
  async getProduct(productId) {
    const product = CATALOG.find((p) => p.productId === productId);
    if (!product) return null;
    const { productId: id, productName, productSlug, unitPrice } = product;
    return { productId: id, productName, productSlug, unitPrice };
  }

  // { weightGrams, lengthCm, breadthCm, heightCm } (any may be absent), or null if unknown product.
  async getPackageInfo(productId) {
    const product = CATALOG.find((p) => p.productId === productId);
    if (!product) return null;
    const { weightGrams, lengthCm, breadthCm, heightCm } = product;
    return { weightGrams, lengthCm, breadthCm, heightCm };
  }
}

module.exports = { MockProductServiceClient, CATALOG };
