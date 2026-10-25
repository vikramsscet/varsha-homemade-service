'use strict';

const cartService = require('./cart.service');
const { success } = require('../../utils/response');

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const create = wrap(async (req, res) => {
  const { cart, created } = await cartService.createCart(req.cartOwner);
  const data = req.cartOwner.anonymousId ? { ...cart, anonymousId: req.cartOwner.anonymousId } : cart;
  return success(res, data, created ? 'Cart created' : 'Existing cart returned', created ? 201 : 200);
});

const current = wrap(async (req, res) =>
  success(res, await cartService.getCurrentCart(req.cartOwner))
);

const get = wrap(async (req, res) =>
  success(res, await cartService.getCart(req.params.cartId, req.cartOwner))
);

const remove = wrap(async (req, res) => {
  await cartService.deleteCart(req.params.cartId, req.cartOwner);
  return success(res, {}, 'Cart deleted');
});

const addItem = wrap(async (req, res) => {
  const { cart, created } = await cartService.addItem(req.params.cartId, req.cartOwner, req.body);
  return success(res, cart, created ? 'Item added' : 'Item quantity increased', created ? 201 : 200);
});

const updateItem = wrap(async (req, res) =>
  success(
    res,
    await cartService.updateItemQuantity(
      req.params.cartId,
      req.params.itemId,
      req.cartOwner,
      req.body.quantity
    ),
    'Item updated'
  )
);

const removeItem = wrap(async (req, res) =>
  success(
    res,
    await cartService.removeItem(req.params.cartId, req.params.itemId, req.cartOwner),
    'Item removed'
  )
);

const clear = wrap(async (req, res) =>
  success(res, await cartService.clearCart(req.params.cartId, req.cartOwner), 'Cart cleared')
);

const merge = wrap(async (req, res) =>
  success(
    res,
    await cartService.mergeAnonymousCart(
      req.params.cartId,
      req.cartOwner.userId,
      req.cartOwner.anonymousId
    ),
    'Carts merged'
  )
);

module.exports = { create, current, get, remove, addItem, updateItem, removeItem, clear, merge };
