-- Manual rollback for 009 (NOT auto-applied).
--   DELETE FROM schema_migrations WHERE name = '009_webhook_processing_lease.sql';
ALTER TABLE payment_webhook_events DROP COLUMN IF EXISTS processing_started_at;
