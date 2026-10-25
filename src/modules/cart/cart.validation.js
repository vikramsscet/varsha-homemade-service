'use strict';

const Joi = require('joi');
const env = require('../../config/env');

const uuid = Joi.string().guid().required();
const quantity = Joi.number().integer().min(1).max(env.cart.maxItemQuantity);

// Unknown fields (e.g. price, subtotal, totalAmount) are stripped by the validate middleware.
const cartParams = Joi.object({ cartId: uuid });
const itemParams = Joi.object({ cartId: uuid, itemId: uuid });
const addItemSchema = Joi.object({
  productId: uuid,
  quantity: quantity.default(1),
});
const updateItemSchema = Joi.object({ quantity: quantity.required() });

module.exports = { cartParams, itemParams, addItemSchema, updateItemSchema };
