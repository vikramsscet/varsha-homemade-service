'use strict';

const env = require('../../config/env');
const { ShiprocketClient } = require('./shiprocketClient');

let client;
const getClient = () => {
  if (!client) client = new ShiprocketClient(env.shiprocket);
  return client;
};

// Services call these through the module object so tests can stub them.
module.exports = {
  checkServiceability: (params) => getClient().checkServiceability(params),
  getRates: (params) => getClient().getRates(params),
  _resetForTests: () => {
    client = undefined;
  },
};
