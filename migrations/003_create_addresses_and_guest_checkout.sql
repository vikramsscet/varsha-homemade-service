-- Saved delivery addresses for registered users.
CREATE TABLE IF NOT EXISTS user_addresses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  phone         VARCHAR(20)  NOT NULL,
  country       CHAR(2)      NOT NULL,
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255),
  city          VARCHAR(100) NOT NULL,
  state         VARCHAR(100) NOT NULL,
  postal_code   VARCHAR(20)  NOT NULL,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one default address per user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_addresses_default
  ON user_addresses (user_id) WHERE is_default = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses (user_id, created_at);

DROP TRIGGER IF EXISTS trg_user_addresses_updated_at ON user_addresses;
CREATE TRIGGER trg_user_addresses_updated_at
  BEFORE UPDATE ON user_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Temporary customer/delivery details for anonymous checkout.
-- Only the SHA-256 hash (hex) of the session token is stored, never the token.
CREATE TABLE IF NOT EXISTS guest_checkout_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token_hash CHAR(64) NOT NULL,
  anonymous_cart_id  UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  email              VARCHAR(320),
  first_name         VARCHAR(100),
  last_name          VARCHAR(100),
  phone              VARCHAR(20),
  country            CHAR(2),
  address_line1      VARCHAR(255),
  address_line2      VARCHAR(255),
  city               VARCHAR(100),
  state              VARCHAR(100),
  postal_code        VARCHAR(20),
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_guest_checkout_sessions_token_hash UNIQUE (session_token_hash)
);

-- One session per cart.
CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_checkout_sessions_cart
  ON guest_checkout_sessions (anonymous_cart_id);
CREATE INDEX IF NOT EXISTS idx_guest_checkout_sessions_expires_at
  ON guest_checkout_sessions (expires_at);

DROP TRIGGER IF EXISTS trg_guest_checkout_sessions_updated_at ON guest_checkout_sessions;
CREATE TRIGGER trg_guest_checkout_sessions_updated_at
  BEFORE UPDATE ON guest_checkout_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
