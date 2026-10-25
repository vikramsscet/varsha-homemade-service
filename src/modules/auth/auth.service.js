'use strict';

const env = require('../../config/env');
const { verifyGoogleCredential } = require('../../config/google');
const { signToken } = require('../../utils/jwt');
const { AppError } = require('../../utils/errors');
const { usersRepository, usersService } = require('../users');

async function loginWithGoogle(credential) {
  const profile = await verifyGoogleCredential(credential);

  let user = await usersRepository.findByGoogleId(profile.googleId);

  if (!user) {
    // Google verified this email, so safely link an existing account with the same email.
    const byEmail = await usersRepository.findByEmail(profile.email);
    if (byEmail) {
      if (byEmail.google_id && byEmail.google_id !== profile.googleId) {
        throw new AppError(409, 'ACCOUNT_CONFLICT', 'Email is linked to a different Google account');
      }
      user = byEmail;
    } else {
      user = await usersRepository.createFromGoogle(profile);
      if (!user) {
        // Lost a creation race with a concurrent login.
        user = (await usersRepository.findByGoogleId(profile.googleId)) ||
          (await usersRepository.findByEmail(profile.email));
      }
    }
  }

  if (!user || user.status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'Account is not active');
  }

  // Updates last_login_at (and profile data) - for brand-new users too, which is harmless.
  user = await usersRepository.recordLogin(user.id, profile);

  return {
    token: signToken(user),
    tokenType: 'Bearer',
    expiresIn: env.jwt.expiresIn,
    user: usersService.toPublicUser(user),
  };
}

module.exports = { loginWithGoogle };
