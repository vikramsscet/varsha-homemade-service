'use strict';

const { AppError } = require('../utils/errors');

// validate(schema, 'body' | 'query' | 'params')
module.exports = (schema, source = 'body') => (req, res, next) => {
  const { value, error } = schema.validate(req[source], {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
    return next(new AppError(400, 'INVALID_REQUEST', 'Invalid request', details));
  }
  req[source] = value;
  return next();
};
