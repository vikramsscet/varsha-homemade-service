'use strict';

// Sample catalog for local development and tests. Never used in production.
const CATALOG = [
  {
    productId: '11111111-1111-4111-8111-111111111111',
    productName: 'Homemade Mango Pickle (500g)',
    productSlug: 'homemade-mango-pickle-500g',
    unitPrice: '249.00',
  },
  {
    productId: '22222222-2222-4222-8222-222222222222',
    productName: 'Besan Laddu (1kg)',
    productSlug: 'besan-laddu-1kg',
    unitPrice: '599.50',
  },
  {
    productId: '33333333-3333-4333-8333-333333333333',
    productName: 'Masala Chakli (250g)',
    productSlug: 'masala-chakli-250g',
    unitPrice: '149.99',
  },
];

class MockProductServiceClient {
  async getProduct(productId) {
    const product = CATALOG.find((p) => p.productId === productId);
    return product ? { ...product } : null;
  }
}

module.exports = { MockProductServiceClient, CATALOG };
