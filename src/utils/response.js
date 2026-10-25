'use strict';

const success = (res, data = {}, message = 'Success', statusCode = 200) =>
  res.status(statusCode).json({ success: true, data, message });

const failure = (res, statusCode, code, message, details) => {
  const error = { code, message };
  if (details) error.details = details;
  return res.status(statusCode).json({ success: false, error });
};

module.exports = { success, failure };
