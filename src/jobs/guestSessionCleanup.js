'use strict';

// The service has no scheduler or cron mechanism, so cleanup runs as a plain in-process timer
// (no new dependency). Every instance runs it; the DELETE is idempotent, so that is safe.
const env = require('../config/env');
const guestCheckoutService = require('../modules/guestCheckout/guestCheckout.service');

let timer = null;

const runOnce = async () => {
  try {
    const deleted = await guestCheckoutService.cleanupExpired();
    if (deleted > 0) {
      console.log(JSON.stringify({ level: 'info', job: 'guestSessionCleanup', deleted }));
    }
    return deleted;
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', job: 'guestSessionCleanup', message: err.message }));
    return 0;
  }
};

const start = () => {
  const minutes = env.guestCheckout.cleanupIntervalMinutes;
  if (timer || minutes <= 0) return;
  timer = setInterval(runOnce, minutes * 60 * 1000);
  timer.unref();
};

const stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { start, stop, runOnce };
