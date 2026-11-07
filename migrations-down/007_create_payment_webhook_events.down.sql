-- Manual rollback for 007 (NOT auto-applied).
--   DELETE FROM schema_migrations WHERE name = '007_create_payment_webhook_events.sql';
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS fk_payment_transactions_webhook_event;
DROP TABLE IF EXISTS payment_webhook_events;
