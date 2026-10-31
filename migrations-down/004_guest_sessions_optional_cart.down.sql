-- Manual rollback for migrations/004 (NOT auto-applied). Fails if sessions without a cart, or
-- several sessions for one cart, exist; delete those rows first. Then:
--   DELETE FROM schema_migrations WHERE name = '004_guest_sessions_optional_cart.sql';
DROP INDEX IF EXISTS idx_guest_checkout_sessions_cart;
CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_checkout_sessions_cart
  ON guest_checkout_sessions (anonymous_cart_id);
ALTER TABLE guest_checkout_sessions ALTER COLUMN anonymous_cart_id SET NOT NULL;
