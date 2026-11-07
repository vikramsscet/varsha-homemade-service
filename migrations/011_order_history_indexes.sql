-- 011: keyset-pagination indexes for GET /orders (a customer's orders, newest first, optional status filter).
-- Matches ORDER BY created_at DESC, id DESC so each page is an index range scan with no sort.
CREATE INDEX IF NOT EXISTS idx_orders_user_history
  ON orders (user_id, created_at DESC, id DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user_status_history
  ON orders (user_id, status, created_at DESC, id DESC) WHERE user_id IS NOT NULL;
