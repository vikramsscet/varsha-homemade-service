'use strict';

const express = require('express');
const db = require('../config/database');
const { success, failure } = require('../utils/response');

const router = express.Router();

router.get('/', (req, res) =>
  success(res, { status: 'UP', uptime: Math.round(process.uptime()) }, 'Service is healthy')
);

router.get('/db', async (req, res) => {
  try {
    await db.query('SELECT 1');
    return success(res, { status: 'UP', database: 'connected' }, 'Database is healthy');
  } catch (err) {
    return failure(res, 503, 'DB_UNAVAILABLE', 'Database unavailable');
  }
});

module.exports = router;
