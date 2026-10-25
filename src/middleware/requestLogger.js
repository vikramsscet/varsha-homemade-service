'use strict';

const crypto = require('crypto');

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Assigns a request ID and logs one line per request.
 * Logs method, path (without query string), status and duration only -
 * never headers or bodies, so JWTs and Google credentials cannot leak.
 */
module.exports = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(ms),
        userId: req.user ? req.user.id : undefined,
      })
    );
  });
  next();
};
