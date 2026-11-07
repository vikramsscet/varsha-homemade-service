'use strict';

const service = require('./orders.service');
const { IDEMPOTENCY_KEY } = require('./orders.validation');
const { success } = require('../../utils/response');
const { AppError } = require('../../utils/errors');

const create = async (req, res, next) => {
  try {
    const key = req.get('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-64 characters of A-Z a-z 0-9 _ . : -');
    }
    const { order, created } = await service.createOrder(req.checkoutIdentity, req.body || {}, key);
    return success(res, order, created ? 'Order created' : 'Existing order returned', created ? 201 : 200);
  } catch (err) {
    return next(err);
  }
};

module.exports = { create };
