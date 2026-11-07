-- 010: non-sensitive payment instrument metadata for order/payment history.
-- Additive and nullable: safe on populated tables, no rewrite, no backfill (older rows stay NULL).
-- Never stores a PAN, CVV, PIN, OTP, expiry or a full UPI handle.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS card_network    VARCHAR(30),   -- VISA, MASTERCARD, RUPAY ...
  ADD COLUMN IF NOT EXISTS card_last4      CHAR(4),
  ADD COLUMN IF NOT EXISTS card_type       VARCHAR(10),   -- CREDIT | DEBIT | PREPAID
  ADD COLUMN IF NOT EXISTS card_issuer     VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_code       VARCHAR(30),   -- netbanking bank code
  ADD COLUMN IF NOT EXISTS wallet_name     VARCHAR(30),
  ADD COLUMN IF NOT EXISTS upi_handle_masked  VARCHAR(100);  -- e.g. ab***@okhdfc

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_instrument_chk;
ALTER TABLE payments ADD CONSTRAINT payments_instrument_chk CHECK (
  (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$')
  AND (card_type IS NULL OR card_type IN ('CREDIT', 'DEBIT', 'PREPAID'))
  -- COALESCE(..., FALSE): a NULL method must not let instrument data through (a CHECK passes on NULL).
  AND ((card_network IS NULL AND card_last4 IS NULL AND card_type IS NULL AND card_issuer IS NULL) OR COALESCE(method = 'card', FALSE))
  AND (bank_code IS NULL OR COALESCE(method = 'netbanking', FALSE))
  AND (wallet_name IS NULL OR COALESCE(method = 'wallet', FALSE))
  AND (upi_handle_masked IS NULL OR COALESCE(method = 'upi', FALSE))
);
