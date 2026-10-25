'use strict';

const express = require('express');
const controller = require('./cart.controller');
const { cartIdentity, mergeIdentity } = require('../../middleware/cartIdentity');
const validate = require('../../middleware/validate');
const { cartParams, itemParams, addItemSchema, updateItemSchema } = require('./cart.validation');

const router = express.Router();
const identify = cartIdentity();

router.post('/', cartIdentity({ allowNewAnonymous: true }), controller.create);
router.get('/current', identify, controller.current); // must stay above '/:cartId'

router.get('/:cartId', identify, validate(cartParams, 'params'), controller.get);
router.delete('/:cartId', identify, validate(cartParams, 'params'), controller.remove);
router.post('/:cartId/merge', mergeIdentity, validate(cartParams, 'params'), controller.merge);

router.post(
  '/:cartId/items',
  identify,
  validate(cartParams, 'params'),
  validate(addItemSchema),
  controller.addItem
);
router.delete('/:cartId/items', identify, validate(cartParams, 'params'), controller.clear);
router.patch(
  '/:cartId/items/:itemId',
  identify,
  validate(itemParams, 'params'),
  validate(updateItemSchema),
  controller.updateItem
);
router.delete('/:cartId/items/:itemId', identify, validate(itemParams, 'params'), controller.removeItem);

module.exports = router;
