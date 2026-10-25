'use strict';

const authService = require('./auth.service');
const { usersService } = require('../users');
const { success } = require('../../utils/response');

const googleLogin = async (req, res, next) => {
  try {
    const result = await authService.loginWithGoogle(req.body.credential);
    return success(res, result, 'Login successful');
  } catch (err) {
    return next(err);
  }
};

const me = async (req, res, next) => {
  try {
    const user = await usersService.getProfile(req.user.id);
    return success(res, user, 'Success');
  } catch (err) {
    return next(err);
  }
};

module.exports = { googleLogin, me };
