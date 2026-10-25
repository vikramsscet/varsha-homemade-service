'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');

const ALGORITHM = 'HS256';

const signToken = (user) =>
  jwt.sign({ email: user.email }, env.jwt.secret, {
    subject: user.id,
    expiresIn: env.jwt.expiresIn,
    algorithm: ALGORITHM,
  });

// Throws on invalid/expired token.
const verifyToken = (token) =>
  jwt.verify(token, env.jwt.secret, { algorithms: [ALGORITHM] });

module.exports = { signToken, verifyToken };
