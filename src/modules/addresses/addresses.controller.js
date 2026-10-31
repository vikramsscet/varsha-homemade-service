'use strict';

const addressService = require('./addresses.service');
const { success } = require('../../utils/response');

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

// The user id always comes from the verified JWT (req.user), never from the request.
const list = wrap(async (req, res) => success(res, await addressService.list(req.user.id)));

const get = wrap(async (req, res) =>
  success(res, await addressService.get(req.user.id, req.params.id))
);

const create = wrap(async (req, res) =>
  success(res, await addressService.create(req.user.id, req.body), 'Address created', 201)
);

const update = wrap(async (req, res) =>
  success(res, await addressService.update(req.user.id, req.params.id, req.body), 'Address updated')
);

const setDefault = wrap(async (req, res) =>
  success(res, await addressService.setDefault(req.user.id, req.params.id), 'Default address updated')
);

const remove = wrap(async (req, res) => {
  await addressService.remove(req.user.id, req.params.id);
  return success(res, {}, 'Address deleted');
});

module.exports = { list, get, create, update, setDefault, remove };
