'use strict';

const { failure } = require('../utils/response');
const { AppError } = require('../utils/errors');

const notFound = (req, res, next) =>
  next(new AppError(404, 'NOT_FOUND', 'Resource not found'));

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return failure(res, err.statusCode, err.code, err.message, err.details);
  }
  if (err.type === 'entity.parse.failed') {
    return failure(res, 400, 'INVALID_REQUEST', 'Malformed JSON body');
  }
  if (err.type === 'entity.too.large') {
    return failure(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  }
  if (err.message === 'Origin not allowed by CORS') {
    return failure(res, 403, 'CORS_FORBIDDEN', 'Origin not allowed');
  }

  // Unexpected: log message + stack (no request body/headers), hide details from client.
  console.error(
    JSON.stringify({ requestId: req.id, level: 'error', message: err.message, stack: err.stack })
  );
  return failure(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
};

module.exports = { notFound, errorHandler };
