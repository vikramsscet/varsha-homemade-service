-- Manual rollback for 006 (NOT auto-applied). Roll back 007 first.
--   DELETE FROM schema_migrations WHERE name = '006_create_payments.sql';
DROP TABLE IF EXISTS payment_transactions;
DROP TABLE IF EXISTS payments;
DROP FUNCTION IF EXISTS prevent_payment_transaction_mutation();
