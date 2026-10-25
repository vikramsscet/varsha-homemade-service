'use strict';

const { verifyToken } = require('../utils/jwt');
const { AppError } = require('../utils/errors');

module.exports = (req, res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (!/^Bearer$/i.test(scheme) || !token) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
    return next(new AppError(401, 'UNAUTHORIZED', message));
  }
};
