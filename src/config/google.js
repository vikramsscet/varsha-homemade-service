'use strict';

const { OAuth2Client } = require('google-auth-library');
const env = require('./env');
const { AppError } = require('../utils/errors');

const client = new OAuth2Client(env.google.clientId);

/**
 * Verifies a Google ID token (signature, expiry, issuer, audience)
 * and returns a normalised profile. The credential is never logged.
 */
async function verifyGoogleCredential(credential) {
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: env.google.clientId,
    });
    payload = ticket.getPayload();
  } catch (err) {
    throw new AppError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Invalid Google credential');
  }

  if (!payload || !payload.sub || !payload.email) {
    throw new AppError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Invalid Google credential');
  }
  if (!payload.email_verified) {
    throw new AppError(401, 'EMAIL_NOT_VERIFIED', 'Google email address is not verified');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    firstName: payload.given_name || null,
    lastName: payload.family_name || null,
    displayName: payload.name || null,
    profileImageUrl: payload.picture || null,
  };
}

module.exports = { verifyGoogleCredential };
