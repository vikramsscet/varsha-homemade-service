-- Phase 2: duplicate-order protection. A cart can have at most ONE unpaid (open) order at a time.
-- Creating an order again for the same unchanged cart returns the existing open order; a changed
-- cart supersedes (cancels) the old open order first. The service serialises on the cart row;
-- this index is the database-level backstop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_one_open_per_cart
  ON orders (cart_id)
  WHERE cart_id IS NOT NULL AND status IN ('PENDING_PAYMENT', 'PAYMENT_FAILED');
