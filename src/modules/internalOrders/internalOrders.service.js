'use strict';

const { createHash } = require('node:crypto');
const repository = require('./internalOrders.repository');
const { paymentMethodSummary, networkLabel } = require('../orders/orders.history');
const { AppError } = require('../../utils/errors');

const SETTLED = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- cursor: bound to the filters it was issued under -------------------------------------------
const badCursor = () =>
  new AppError(400, 'INVALID_REQUEST', 'Invalid request', [{ field: 'cursor', message: 'cursor is invalid' }]);

const fingerprint = (filters) => {
  const canonical = Object.keys(filters).sort().filter((k) => filters[k] !== undefined)
    .map((k) => [k, filters[k] instanceof Date ? filters[k].toISOString() : filters[k]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
};

const encodeCursor = (row, fp) =>
  Buffer.from(JSON.stringify({ t: row.cursor_ts, i: row.id, f: fp })).toString('base64url');

const decodeCursor = (cursor, fp) => {
  let c;
  try {
    c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (!c || !ISO_US.test(c.t) || !UUID.test(c.i) || c.f !== fp) throw badCursor();
  return { createdAt: c.t, id: c.i };
};

// ---- views ----------------------------------------------------------------------------------------
const customerOf = (r) => ({
  userId: r.customer_type === 'USER' ? r.user_id : null,
  firstName: r.user_first_name || r.shipping_first_name || null,
  lastName: r.user_last_name || r.shipping_last_name || null,
  email: r.customer_email || null,
  phone: r.customer_phone || null,
  customerType: r.customer_type === 'USER' ? 'REGISTERED' : 'GUEST',
});

const summaryOf = (r) => ({
  id: r.id,
  orderNumber: r.order_number,
  status: r.status,
  currency: r.currency.trim(),
  subtotal: Number(r.subtotal),
  discountAmount: Number(r.discount_amount),
  taxAmount: Number(r.tax_amount),
  shippingAmount: Number(r.shipping_amount),
  totalAmount: Number(r.total_amount),
  customer: customerOf(r),
  createdAt: r.created_at,
  paidAt: r.paid_at || null,
});

const toListItem = (r) => ({
  ...summaryOf(r),
  paymentStatus: r.payment_status || null,
  paymentMethodSummary: r.payment_status
    ? paymentMethodSummary({
      method: r.payment_method, card_network: r.card_network, card_last4: r.card_last4,
      bank_code: r.bank_code, wallet_name: r.wallet_name,
    })
    : null,
});

const toPayment = (p) => ({
  paymentId: p.id,
  attemptNumber: p.attempt_number,
  razorpayPaymentId: p.razorpay_payment_id || null,
  paymentStatus: p.status,
  paymentMethod: p.method || null,
  paymentMethodSummary: paymentMethodSummary(p),
  amount: Number(p.amount), // major currency units, like the order amounts
  amountRefunded: Number(p.amount_refunded),
  currency: p.currency.trim(),
  card: p.method === 'card'
    ? {
      network: networkLabel(p.card_network),
      last4: p.card_last4 || null,
      type: p.card_type ? p.card_type.toLowerCase() : null,
      issuer: p.card_issuer || null,
    }
    : null,
  bankCode: p.method === 'netbanking' ? p.bank_code || null : null,
  walletName: p.method === 'wallet' ? p.wallet_name || null : null,
  upiHandleMasked: p.method === 'upi' ? p.upi_handle_masked || null : null,
  failureCode: p.failure_code || null,
  failureReason: p.failure_reason || null,
  createdAt: p.created_at,
  authorizedAt: p.authorized_at || null,
  capturedAt: p.captured_at || null,
  failedAt: p.failed_at || null,
});

// ---- use cases ------------------------------------------------------------------------------------
const listOrders = async ({ cursor, limit, ...filters }, { userId } = {}) => {
  const fp = fingerprint({ ...filters, userId });
  const after = cursor ? decodeCursor(cursor, fp) : null;
  const rows = await repository.listPage({ ...filters, userId, after, limit });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(toListItem),
    pagination: { nextCursor: hasMore ? encodeCursor(page[page.length - 1], fp) : null, hasMore },
  };
};

const getOrder = async (orderId) => {
  const order = await repository.findOrder(orderId);
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const [items, payments] = await Promise.all([repository.listItems(order.id), repository.listPayments(order.id)]);
  const primary = payments.find((p) => SETTLED.includes(p.status)) || payments[0] || null;
  return {
    ...summaryOf(order),
    paymentStatus: primary ? primary.status : null,
    paymentMethodSummary: primary ? paymentMethodSummary(primary) : null,
    items: items.map((i) => ({
      productId: i.product_id,
      productName: i.product_name,
      productSlug: i.product_slug,
      unitPrice: Number(i.unit_price),
      quantity: i.quantity,
      totalPrice: Number(i.total_price),
    })),
    shippingAddress: {
      firstName: order.shipping_first_name,
      lastName: order.shipping_last_name,
      phone: order.shipping_phone,
      country: order.shipping_country.trim(),
      addressLine1: order.shipping_address_line1,
      addressLine2: order.shipping_address_line2,
      city: order.shipping_city,
      state: order.shipping_state,
      postalCode: order.shipping_postal_code,
    },
    payments: payments.map(toPayment),
    confirmedAt: order.confirmed_at || null,
    cancelledAt: order.cancelled_at || null,
    updatedAt: order.updated_at,
  };
};

module.exports = { listOrders, getOrder, fingerprint, encodeCursor, decodeCursor };
