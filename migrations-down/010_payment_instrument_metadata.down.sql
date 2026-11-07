-- Manual rollback for 010 (NOT auto-applied).
--   DELETE FROM schema_migrations WHERE name = '010_payment_instrument_metadata.sql';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_instrument_chk;
ALTER TABLE payments
  DROP COLUMN IF EXISTS card_network,
  DROP COLUMN IF EXISTS card_last4,
  DROP COLUMN IF EXISTS card_type,
  DROP COLUMN IF EXISTS card_issuer,
  DROP COLUMN IF EXISTS bank_code,
  DROP COLUMN IF EXISTS wallet_name,
  DROP COLUMN IF EXISTS upi_handle_masked;
