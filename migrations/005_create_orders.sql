-- Orders + order items. An internal order is created BEFORE any payment is initiated.
-- Orders are historical records: prices and delivery details are SNAPSHOTS, never joins to
-- carts / addresses / guest sessions (which are mutable or deleted by cleanup jobs).

CREATE SEQUENCE IF NOT EXISTS order_number_seq START 100001;

CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-facing reference, e.g. VH261106-100001
  order_number      VARCHAR(30) NOT NULL
                    DEFAULT ('VH' || to_char(NOW(), 'YYMMDD') || '-' || nextval('order_number_seq')::text),

  -- Ownership: authenticated user OR guest. Neither FK is the source of truth for contact info
  -- (see snapshot columns); guest_session_id is nulled when the temporary session is cleaned up.
  customer_type     VARCHAR(10) NOT NULL CHECK (customer_type IN ('USER', 'GUEST')),
  user_id           UUID REFERENCES users(id) ON DELETE RESTRICT,
  guest_session_id  UUID REFERENCES guest_checkout_sessions(id) ON DELETE SET NULL,
  -- Guests view/retry their order with this token; only the SHA-256 hex hash is stored.
  guest_access_token_hash CHAR(64),
  -- Source cart is a weak reference only (cart may be purged); no cascade.
  cart_id           UUID REFERENCES carts(id) ON DELETE SET NULL,
  -- Client-supplied key making "create order from checkout" safe to retry.
  checkout_idempotency_key VARCHAR(100),

  status            VARCHAR(25) NOT NULL DEFAULT 'PENDING_PAYMENT'
                    CHECK (status IN ('PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAID',
                                      'CANCELLED', 'EXPIRED',
                                      'PARTIALLY_REFUNDED', 'REFUNDED')),
  currency          CHAR(3) NOT NULL DEFAULT 'INR',
  subtotal          NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  discount_amount   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  shipping_amount   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  total_amount      NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),

  -- Customer snapshot (copied at order creation)
  customer_email    VARCHAR(320) NOT NULL,
  customer_phone    VARCHAR(20),
  -- Delivery address snapshot (copied from user_addresses / guest_checkout_sessions)
  shipping_first_name    VARCHAR(100) NOT NULL,
  shipping_last_name     VARCHAR(100) NOT NULL,
  shipping_phone         VARCHAR(20)  NOT NULL,
  shipping_country       CHAR(2)      NOT NULL,
  shipping_address_line1 VARCHAR(255) NOT NULL,
  shipping_address_line2 VARCHAR(255),
  shipping_city          VARCHAR(100) NOT NULL,
  shipping_state         VARCHAR(100) NOT NULL,
  shipping_postal_code   VARCHAR(20)  NOT NULL,

  -- Order is confirmed exactly once: set with `UPDATE ... WHERE confirmed_at IS NULL`.
  confirmed_at      TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  -- Unpaid orders become ineligible for payment after this time.
  payment_expires_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_orders_order_number UNIQUE (order_number),
  CONSTRAINT orders_owner_chk CHECK (
    (customer_type = 'USER'  AND user_id IS NOT NULL AND guest_session_id IS NULL AND guest_access_token_hash IS NULL)
    OR
    (customer_type = 'GUEST' AND user_id IS NULL AND guest_access_token_hash IS NOT NULL)
  ),
  CONSTRAINT orders_total_chk CHECK (total_amount = subtotal - discount_amount + tax_amount + shipping_amount),
  CONSTRAINT orders_paid_chk CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_idempotency_key
  ON orders (checkout_idempotency_key) WHERE checkout_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_guest_token_hash
  ON orders (guest_access_token_hash) WHERE guest_access_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_guest_session ON orders (guest_session_id) WHERE guest_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_cart ON orders (cart_id) WHERE cart_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders (lower(customer_email));
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_at);
-- Expiry sweeper: unpaid orders past their payment window.
CREATE INDEX IF NOT EXISTS idx_orders_unpaid_expiry ON orders (payment_expires_at)
  WHERE status IN ('PENDING_PAYMENT', 'PAYMENT_FAILED');

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- product_id is a reference into the external product service (no FK); name/slug/price are snapshots.
  product_id    UUID NOT NULL,
  product_name  VARCHAR(255) NOT NULL,
  product_slug  VARCHAR(255) NOT NULL,
  unit_price    NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  total_price   NUMERIC(12,2) NOT NULL CHECK (total_price >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_order_items_order_product UNIQUE (order_id, product_id),
  CONSTRAINT order_items_total_chk CHECK (total_price = unit_price * quantity)
);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
