'use strict';

const service = require('./internalOrders.service');
const { listQuerySchema, userListQuerySchema } = require('./internalOrders.validation');
const { success } = require('../../utils/response');
const { AppError } = require('../../utils/errors');

// Express 5 exposes req.query as a read-only getter, so the query is validated here.
const parseQuery = (schema, query) => {
  const { value, error } = schema.validate(query, { abortEarly: false, stripUnknown: true });
  if (error) {
    const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
    throw new AppError(400, 'INVALID_REQUEST', 'Invalid request', details);
  }
  for (const key of ['createdFrom', 'createdBefore']) {
    if (value[key]) value[key] = value[key].toISOString();
  }
  return value;
};

const list = async (req, res, next) => {
  try {
    return success(res, await service.listOrders(parseQuery(listQuerySchema, req.query)), 'Orders retrieved successfully');
  } catch (err) {
    return next(err);
  }
};

const listForUser = async (req, res, next) => {
  try {
    const data = await service.listOrders(parseQuery(userListQuerySchema, req.query), { userId: req.params.userId });
    return success(res, data, 'User orders retrieved successfully');
  } catch (err) {
    return next(err);
  }
};

const get = async (req, res, next) => {
  try {
    return success(res, await service.getOrder(req.params.orderId), 'Order retrieved successfully');
  } catch (err) {
    return next(err);
  }
};

module.exports = { list, listForUser, get };
