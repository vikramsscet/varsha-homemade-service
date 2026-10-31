-- Phase 4 adjustments to guest_checkout_sessions (see 003):
--  * a session may be created without a cart (anonymous_cart_id optional)
--  * several sessions may reference the same cart (a cart id never selects/reuses a session)
ALTER TABLE guest_checkout_sessions ALTER COLUMN anonymous_cart_id DROP NOT NULL;
DROP INDEX IF EXISTS uq_guest_checkout_sessions_cart;
CREATE INDEX IF NOT EXISTS idx_guest_checkout_sessions_cart
  ON guest_checkout_sessions (anonymous_cart_id) WHERE anonymous_cart_id IS NOT NULL;
