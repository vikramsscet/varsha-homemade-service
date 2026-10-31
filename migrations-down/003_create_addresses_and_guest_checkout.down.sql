-- Manual rollback for migrations/003 (the runner is forward-only; this folder is NOT auto-applied).
-- Run inside a transaction, then remove the record so 003 can be re-applied:
--   BEGIN; \i this_file.sql; DELETE FROM schema_migrations WHERE name = '003_create_addresses_and_guest_checkout.sql'; COMMIT;
-- Drops only the two new tables; users/carts/cart_items and set_updated_at() are untouched.
DROP TABLE IF EXISTS guest_checkout_sessions;
DROP TABLE IF EXISTS user_addresses;
