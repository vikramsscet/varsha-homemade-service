'use strict';

// Order history for authenticated customers: cursor pagination, order-level payment summary and the
// historical order view. Reads snapshots only (order, order_items, payments); the product catalogue and
// the customer's current saved addresses are never consulted.

const repository = require('./orders.history.repository');
const { toMinor } = require('./orders.pricing');
const { AppError } = require('../../utils/errors');

// ---- payment method display ---------------------------------------------------------------------
const NETWORKS = {
  VISA: 'Visa', MASTERCARD: 'Mastercard', RUPAY: 'RuPay', AMERICAN_EXPRESS: 'American Express',
  AMEX: 'American Express', DINERS_CLUB: 'Diners Club', DISCOVER: 'Discover', JCB: 'JCB',
  MAESTRO: 'Maestro', UNIONPAY: 'UnionPay', BAJAJ: 'Bajaj Finserv',
};
const titleCase = (s) =>
  String(s).toLowerCase().split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const networkLabel = (n) => (n ? NETWORKS[n] || titleCase(n) : null);

/** Customer-friendly label from persisted metadata only; never contains a full UPI handle. */
const paymentMethodSummary = (p) => {
  switch (p.method) {
    case 'card': {
      const network = networkLabel(p.card_network);
      if (network && p.card_last4) return `${network} •••• ${p.card_last4}`;
      if (p.card_last4) return `Card •••• ${p.card_last4}`;
      return network ? `${network} card` : 'Card';
    }
    case 'upi': return 'UPI';
    case 'netbanking': return p.bank_code ? `${p.bank_code} netbanking` : 'Netbanking';
    case 'wallet': return p.wallet_name ? titleCase(p.wallet_name) : 'Wallet';
    case null:
    case undefined: return null;
    default: return titleCase(p.method); // e.g. emi, paylater
  }
};

// Only the metadata that belongs to the payment's method is returned.
const methodDetails = (p) => ({
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
});

// ---- cursor ---------------------------------------------------------------------------------------
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badCursor = () =>
  new AppError(400, 'INVALID_REQUEST', 'Invalid request', [{ field: 'cursor', message: 'cursor is invalid' }]);

const encodeCursor = (row, status) =>
  Buffer.from(JSON.stringify({ t: row.cursor_ts, i: row.id, s: status || null })).toString('base64url');

const decodeCursor = (cursor, status) => {
  let c;
  try {
    c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  // A cursor is only valid for the filter it was issued under.
  if (!c || !ISO_US.test(c.t) || !UUID.test(c.i) || (c.s || null) !== (status || null)) throw badCursor();
  return { createdAt: c.t, id: c.i };
};

// ---- views ----------------------------------------------------------------------------------------
const toListItem = (r) => ({
  id: r.id,
  orderNumber: r.order_number,
  status: r.status,
  currency: r.currency.trim(),
  subtotal: Number(r.subtotal),
  discountAmount: Number(r.discount_amount),
  taxAmount: Number(r.tax_amount),
  shippingAmount: Number(r.shipping_amount),
  totalAmount: Number(r.total_amount),
  paymentStatus: r.payment_status || null,
  paymentMethodSummary: r.payment_id
    ? paymentMethodSummary({
      method: r.payment_method, card_network: r.card_network, card_last4: r.card_last4,
      bank_code: r.bank_code, wallet_name: r.wallet_name,
    })
    : null,
  createdAt: r.created_at,
});

const toPaymentView = (p) => ({
  paymentId: p.id,
  razorpayPaymentId: p.razorpay_payment_id || null,
  paymentStatus: p.status,
  paymentMethod: p.method || null,
  paymentMethodSummary: paymentMethodSummary(p),
  amount: toMinor(p.amount), // minor units (paise), like POST /payments/create-order
  currency: p.currency.trim(),
  ...methodDetails(p),
  createdAt: p.created_at,
  capturedAt: p.captured_at || null,
});

// ---- use cases ------------------------------------------------------------------------------------
const listOrders = async (userId, { cursor, limit, status }) => {
  const after = cursor ? decodeCursor(cursor, status) : null;
  const rows = await repository.listPage(userId, { status, after, limit });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(toListItem),
    pagination: { nextCursor: hasMore ? encodeCursor(page[page.length - 1], status) : null, hasMore },
  };
};

const getOrder = async (userId, orderId) => {
  const order = await repository.findOwnedOrder(userId, orderId);
  // Same answer for "does not exist" and "belongs to someone else".
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const [items, payments] = await Promise.all([repository.listItems(order.id), repository.listPayments(order.id)]);
  const settled = payments.find((p) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));
  const primary = settled || payments[0] || null; // payments are newest attempt first
  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    currency: order.currency.trim(),
    subtotal: Number(order.subtotal),
    discountAmount: Number(order.discount_amount),
    taxAmount: Number(order.tax_amount),
    shippingAmount: Number(order.shipping_amount),
    totalAmount: Number(order.total_amount),
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
    payments: payments.map(toPaymentView),
    paidAt: order.paid_at,
    createdAt: order.created_at,
  };
};

module.exports = { listOrders, getOrder, paymentMethodSummary, encodeCursor, decodeCursor, networkLabel };
