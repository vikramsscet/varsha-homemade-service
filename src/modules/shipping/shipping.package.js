'use strict';

const { AppError } = require('../../utils/errors');

const isPositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const ceilTo = (n, decimals) => {
  const f = 10 ** decimals;
  return Math.ceil(n * f - 1e-9) / f;
};

/**
 * Builds one shipping package from cart lines. Packaging strategy: items are stacked in a single box -
 * length/breadth are the largest footprint among items, height is the sum of every unit's height.
 * Weight = sum(unit weight x quantity) + the configured packaging (box/filler) weight.
 *
 * lines: [{ productId, quantity, info: { weightGrams, lengthCm, breadthCm, heightCm } | null }]
 * Returns { weightKg, lengthCm, breadthCm, heightCm }. Throws 422 if any product lacks valid package data
 * rather than guessing values.
 */
const buildPackage = (lines, { packagingWeightGrams = 0 } = {}) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new AppError(422, 'CART_EMPTY', 'Cart is empty');
  }

  const invalid = lines
    .filter(({ info }) =>
      !info || !['weightGrams', 'lengthCm', 'breadthCm', 'heightCm'].every((k) => isPositive(info[k]))
    )
    .map(({ productId }) => ({ field: 'productId', message: `Package weight/dimensions missing for product ${productId}` }));
  if (invalid.length > 0) {
    throw new AppError(
      422,
      'PRODUCT_PACKAGE_INFO_MISSING',
      'Delivery cannot be checked because some products have no package weight or dimensions',
      invalid
    );
  }

  let grams = Math.max(0, packagingWeightGrams);
  let length = 0;
  let breadth = 0;
  let height = 0;
  for (const { quantity, info } of lines) {
    grams += info.weightGrams * quantity;
    length = Math.max(length, info.lengthCm);
    breadth = Math.max(breadth, info.breadthCm);
    height += info.heightCm * quantity;
  }

  return {
    weightKg: ceilTo(grams / 1000, 2),
    lengthCm: ceilTo(length, 1),
    breadthCm: ceilTo(breadth, 1),
    heightCm: ceilTo(height, 1),
  };
};

module.exports = { buildPackage };
