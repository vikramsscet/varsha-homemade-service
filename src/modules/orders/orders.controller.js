'use strict';

const service = require('./orders.service');
const history = require('./orders.history');
const { IDEMPOTENCY_KEY, listOrdersQuerySchema } = require('./orders.validation');
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

// Express 5 exposes req.query as a read-only getter, so the query is validated here instead of via validate().
const listQuery = (query) => {
  const { value, error } = listOrdersQuerySchema.validate(query, { abortEarly: false, stripUnknown: true });
  if (error) {
    const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
    throw new AppError(400, 'INVALID_REQUEST', 'Invalid request', details);
  }
  return value;
};

// userId always comes from the verified JWT (req.user), never from query, params or body.
const list = async (req, res, next) => {
  try {
    const data = await history.listOrders(req.user.id, listQuery(req.query));
    res.set('Cache-Control', 'private, no-store');
    return success(res, data, 'Orders retrieved successfully');
  } catch (err) {
    return next(err);
  }
};

const get = async (req, res, next) => {
  try {
    const data = await history.getOrder(req.user.id, req.params.id);
    res.set('Cache-Control', 'private, no-store');
    return success(res, data, 'Order retrieved successfully');
  } catch (err) {
    return next(err);
  }
};

module.exports = { create, list, get };
