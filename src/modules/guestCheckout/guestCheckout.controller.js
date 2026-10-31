'use strict';

const service = require('./guestCheckout.service');
const { success } = require('../../utils/response');

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

// The raw token appears only in this one response and is never logged.
const create = wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return success(res, await service.create(req.body || {}), 'Guest checkout session created', 201);
});

const get = wrap(async (req, res) => success(res, service.get(req.guestSession)));

const update = wrap(async (req, res) =>
  success(res, await service.update(req.guestSession, req.body), 'Checkout details updated')
);

const remove = wrap(async (req, res) => {
  await service.remove(req.guestSession);
  return success(res, {}, 'Guest checkout session deleted');
});

module.exports = { create, get, update, remove };
