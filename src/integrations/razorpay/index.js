'use strict';

const env = require('../../config/env');
const { RazorpayClient } = require('./razorpayClient');

let client;
const getClient = () => {
  if (!client) client = new RazorpayClient(env.razorpay);
  return client;
};

// Services call these through the module object so tests can stub them.
module.exports = {
  createOrder: (params) => getClient().createOrder(params),
  verifySignature: (params) => getClient().verifySignature(params),
  verifyWebhookSignature: (rawBody, signature) => getClient().verifyWebhookSignature(rawBody, signature),
  fetchPayment: (paymentId) => getClient().fetchPayment(paymentId),
  // The public key id is safe to expose to the browser; the secret never leaves RazorpayClient.
  getKeyId: () => {
    getClient().assertConfigured();
    return env.razorpay.keyId;
  },
};
