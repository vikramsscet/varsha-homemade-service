'use strict';

const env = require('./config/env');
const app = require('./app');
const db = require('./config/database');
const guestSessionCleanup = require('./jobs/guestSessionCleanup');

const server = app.listen(env.port, () => {
  console.log(`user-and-cart-service listening on port ${env.port} (${env.nodeEnv})`);
});

guestSessionCleanup.start();

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);
  guestSessionCleanup.stop();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.message);
});
