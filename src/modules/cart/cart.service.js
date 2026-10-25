'use strict';

const env = require('../../config/env');
const db = require('../../config/database');
const repository = require('./cart.repository');
const pricing = require('./cart.pricing');
const { productServiceClient } = require('../../integrations/product');
const { AppError } = require('../../utils/errors');

const { maxItemQuantity, maxDistinctItems, anonymousTtlDays } = env.cart;

// owner is either { userId } or { anonymousId }.
const ownerType = (owner) => (owner.userId ? 'USER' : 'ANONYMOUS');

const toItemView = (row) => ({
  id: row.id,
  productId: row.product_id,
  productName: row.product_name,
  productSlug: row.product_slug,
  unitPrice: Number(row.unit_price),
  quantity: row.quantity,
  totalPrice: Number(row.total_price),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Public shape of a cart - the only place cart rows are mapped for API output.
const toCartView = (cart, items) => ({
  id: cart.id,
  ownerType: cart.user_id ? 'USER' : 'ANONYMOUS',
  userId: cart.user_id,
  status: cart.status,
  currency: cart.currency,
  subtotal: Number(cart.subtotal),
  discountAmount: Number(cart.discount_amount),
  taxAmount: Number(cart.tax_amount),
  totalAmount: Number(cart.total_amount),
  itemCount: items.reduce((n, i) => n + i.quantity, 0),
  items: items.map(toItemView),
  expiresAt: cart.expires_at,
  createdAt: cart.created_at,
  updatedAt: cart.updated_at,
});

const notFound = () => new AppError(404, 'CART_NOT_FOUND', 'Cart not found');
const notActive = (cart) =>
  new AppError(409, 'CART_NOT_ACTIVE', `Cart is ${cart.status.toLowerCase()} and cannot be modified`);

const view = async (cart, client) => toCartView(cart, await repository.listItems(cart.id, client));

// Recomputes every amount from the item rows; client-supplied amounts are never used.
const recalculate = async (cartId, client) => {
  const items = await repository.listItems(cartId, client);
  const current = await repository.updateTotals(
    cartId,
    pricing.calculateTotals(items), // discount/tax are 0 until those engines exist
    client
  );
  return toCartView(current, items);
};

// Load an owned cart inside a transaction, locking the row, and require it to be ACTIVE.
const lockActive = async (cartId, owner, client) => {
  const cart = await repository.findOwnedById(cartId, owner, { lock: true }, client);
  if (!cart) throw notFound();
  if (cart.status !== 'ACTIVE') throw notActive(cart);
  return cart;
};

const expiryFor = (owner) =>
  owner.anonymousId ? new Date(Date.now() + anonymousTtlDays * 24 * 60 * 60 * 1000) : null;

// ---- carts -------------------------------------------------------------------------------

// Idempotent: returns the owner's existing ACTIVE cart, or creates one.
const createCart = async (owner) => {
  await repository.markStaleExpired(owner);
  try {
    const existing = await repository.findActiveByOwner(owner);
    if (existing) return { cart: await view(existing), created: false };

    let cart = await repository.insertCart(owner, expiryFor(owner));
    let created = true;
    if (!cart) {
      // Lost a race with a concurrent create.
      cart = await repository.findActiveByOwner(owner);
      created = false;
    }
    return { cart: await view(cart), created };
  } catch (err) {
    if (err.code === '23503') throw new AppError(401, 'UNAUTHORIZED', 'Invalid token');
    throw err;
  }
};

const getCurrentCart = async (owner) => {
  await repository.markStaleExpired(owner);
  const cart = await repository.findActiveByOwner(owner);
  if (!cart) throw notFound();
  return view(cart);
};

const getCart = async (cartId, owner) => {
  await repository.markStaleExpired(owner);
  const cart = await repository.findOwnedById(cartId, owner);
  if (!cart) throw notFound();
  return view(cart);
};

// Hard-deletes an ACTIVE cart (items cascade). Non-active carts are kept for history/orders.
const deleteCart = async (cartId, owner) => {
  await repository.markStaleExpired(owner);
  await db.withTransaction(async (client) => {
    await lockActive(cartId, owner, client);
    await repository.deleteCart(cartId, client);
  });
};

// ---- items -------------------------------------------------------------------------------

const addItem = async (cartId, owner, { productId, quantity }) => {
  await repository.markStaleExpired(owner);

  // Fail fast on ownership/state before calling the Product CMS (no locks held during the call).
  const pre = await repository.findOwnedById(cartId, owner);
  if (!pre) throw notFound();
  if (pre.status !== 'ACTIVE') throw notActive(pre);

  const product = await productServiceClient.getProduct(productId);
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');

  return db.withTransaction(async (client) => {
    await lockActive(cartId, owner, client);

    const existing = await repository.findItemByProduct(cartId, productId, client);
    const newQuantity = (existing ? existing.quantity : 0) + quantity;
    if (newQuantity > maxItemQuantity) {
      throw new AppError(422, 'QUANTITY_LIMIT_EXCEEDED', `Maximum quantity per item is ${maxItemQuantity}`);
    }
    if (!existing && (await repository.countItems(cartId, client)) >= maxDistinctItems) {
      throw new AppError(422, 'CART_ITEM_LIMIT_EXCEEDED', `A cart can hold at most ${maxDistinctItems} products`);
    }

    // Name, slug and price always come from the Product CMS, refreshed on every add.
    const snapshot = {
      productId,
      productName: product.productName,
      productSlug: product.productSlug,
      unitPrice: pricing.normalizeMoney(product.unitPrice),
      quantity: newQuantity,
    };
    snapshot.totalPrice = pricing.calculateItemTotal(snapshot.unitPrice, newQuantity);

    if (existing) await repository.updateItem(existing.id, snapshot, client);
    else await repository.insertItem(cartId, snapshot, client);

    return { cart: await recalculate(cartId, client), created: !existing };
  });
};

// Sets the quantity (absolute). Keeps the price snapshot taken when the item was added.
const updateItemQuantity = async (cartId, itemId, owner, quantity) => {
  await repository.markStaleExpired(owner);
  return db.withTransaction(async (client) => {
    await lockActive(cartId, owner, client);
    const item = await repository.findItem(cartId, itemId, client);
    if (!item) throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found');

    await repository.updateItem(
      item.id,
      {
        productName: item.product_name,
        productSlug: item.product_slug,
        unitPrice: item.unit_price,
        quantity,
        totalPrice: pricing.calculateItemTotal(item.unit_price, quantity),
      },
      client
    );
    return recalculate(cartId, client);
  });
};

const removeItem = async (cartId, itemId, owner) => {
  await repository.markStaleExpired(owner);
  return db.withTransaction(async (client) => {
    await lockActive(cartId, owner, client);
    const removed = await repository.deleteItem(cartId, itemId, client);
    if (!removed) throw new AppError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found');
    return recalculate(cartId, client);
  });
};

const clearCart = async (cartId, owner) => {
  await repository.markStaleExpired(owner);
  return db.withTransaction(async (client) => {
    await lockActive(cartId, owner, client);
    await repository.deleteAllItems(cartId, client);
    return recalculate(cartId, client);
  });
};

// ---- merge -------------------------------------------------------------------------------

// Merges an anonymous cart into the user's ACTIVE cart (created if missing), atomically.
const mergeAnonymousCart = async (anonymousCartId, userId, anonymousId) => {
  await repository.markStaleExpired({ userId });
  await repository.markStaleExpired({ anonymousId });

  return db.withTransaction(async (client) => {
    const source = await lockActive(anonymousCartId, { anonymousId }, client);

    let target = await repository.insertCart({ userId }, null, client);
    if (!target) target = await repository.findActiveByOwner({ userId }, { lock: true }, client);

    for (const item of await repository.listItems(source.id, client)) {
      const existing = await repository.findItemByProduct(target.id, item.product_id, client);
      if (existing) {
        // Same product in both carts: quantities add up (capped at the per-item maximum).
        const quantity = Math.min(existing.quantity + item.quantity, maxItemQuantity);
        await repository.updateItem(
          existing.id,
          {
            productName: existing.product_name,
            productSlug: existing.product_slug,
            unitPrice: existing.unit_price,
            quantity,
            totalPrice: pricing.calculateItemTotal(existing.unit_price, quantity),
          },
          client
        );
      } else {
        if ((await repository.countItems(target.id, client)) >= maxDistinctItems) {
          throw new AppError(422, 'CART_ITEM_LIMIT_EXCEEDED', `A cart can hold at most ${maxDistinctItems} products`);
        }
        await repository.insertItem(
          target.id,
          {
            productId: item.product_id,
            productName: item.product_name,
            productSlug: item.product_slug,
            unitPrice: item.unit_price,
            quantity: item.quantity,
            totalPrice: item.total_price,
          },
          client
        );
      }
    }

    const merged = await recalculate(target.id, client);
    await repository.setStatus(source.id, 'ABANDONED', client);
    return merged;
  });
};

// ---- hooks for the Checkout phase ----------------------------------------------------------

// Checkout will call this inside its own transaction once an order is created.
const markCompleted = async (cartId, client) => repository.setStatus(cartId, 'COMPLETED', client);

module.exports = {
  createCart,
  getCurrentCart,
  getCart,
  deleteCart,
  addItem,
  updateItemQuantity,
  removeItem,
  clearCart,
  mergeAnonymousCart,
  markCompleted,
  ownerType,
};
