'use strict';

const repository = require('./users.repository');
const { AppError } = require('../../utils/errors');

// Public shape of a user - the only place DB rows are mapped for API output.
const toPublicUser = (row) => ({
  id: row.id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  displayName: row.display_name,
  profileImageUrl: row.profile_image_url,
  emailVerified: row.email_verified,
  status: row.status,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

const getProfile = async (userId) => {
  const user = await repository.findById(userId);
  if (!user || user.status !== 'ACTIVE') {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }
  return toPublicUser(user);
};

module.exports = { getProfile, toPublicUser };
