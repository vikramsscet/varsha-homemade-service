'use strict';

const db = require('../../config/database');
const repository = require('./addresses.repository');
const { AppError } = require('../../utils/errors');
const { toName } = require('../../utils/country');

const MAX_ADDRESSES_PER_USER = 20;

const toDto = (r) => ({
  id: r.id,
  firstName: r.first_name,
  lastName: r.last_name,
  phone: r.phone,
  country: r.country.trim(),
  countryName: toName(r.country.trim()),
  addressLine1: r.address_line1,
  addressLine2: r.address_line2,
  city: r.city,
  state: r.state,
  postalCode: r.postal_code,
  isDefault: r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const notFound = () => new AppError(404, 'ADDRESS_NOT_FOUND', 'Address not found');

// Runs fn(client) in a transaction holding a row lock on the user, so concurrent address
// writes for the same user are serialised (the partial unique index is the final backstop).
const withUserLock = (userId, fn) =>
  db.withTransaction(async (client) => {
    if (!(await repository.lockUser(userId, client))) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    return fn(client);
  });

const list = async (userId) => (await repository.listByUser(userId)).map(toDto);

const get = async (userId, id) => {
  const row = await repository.findOwned(id, userId);
  if (!row) throw notFound();
  return toDto(row);
};

const create = (userId, input) =>
  withUserLock(userId, async (client) => {
    const count = await repository.countByUser(userId, client);
    if (count >= MAX_ADDRESSES_PER_USER) {
      throw new AppError(409, 'ADDRESS_LIMIT_REACHED', `At most ${MAX_ADDRESSES_PER_USER} addresses are allowed`);
    }
    const isDefault = count === 0 || input.isDefault === true;
    if (isDefault) await repository.clearDefault(userId, client);
    return toDto(await repository.insert(userId, input, isDefault, client));
  });

const update = (userId, id, input) =>
  withUserLock(userId, async (client) => {
    const existing = await repository.findOwned(id, userId, client);
    if (!existing) throw notFound();

    let isDefault = existing.is_default;
    if (input.isDefault === true && !existing.is_default) {
      await repository.clearDefault(userId, client);
      isDefault = true;
    } else if (input.isDefault === false && existing.is_default) {
      throw new AppError(
        400,
        'INVALID_ADDRESS',
        'The default address cannot be unset directly; set another address as default instead'
      );
    }
    return toDto(await repository.update(id, userId, input, isDefault, client));
  });

const setDefault = (userId, id) =>
  withUserLock(userId, async (client) => {
    const existing = await repository.findOwned(id, userId, client);
    if (!existing) throw notFound();
    if (existing.is_default) return toDto(existing);
    await repository.clearDefault(userId, client);
    return toDto(await repository.setDefault(id, userId, client));
  });

const remove = (userId, id) =>
  withUserLock(userId, async (client) => {
    const existing = await repository.findOwned(id, userId, client);
    if (!existing) throw notFound();
    await repository.remove(id, userId, client);
    if (existing.is_default) await repository.promoteLatest(userId, client);
  });

module.exports = { list, get, create, update, setDefault, remove };
