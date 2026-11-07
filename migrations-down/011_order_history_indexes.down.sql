-- Manual rollback for 011 (NOT auto-applied).
--   DELETE FROM schema_migrations WHERE name = '011_order_history_indexes.sql';
DROP INDEX IF EXISTS idx_orders_user_status_history;
DROP INDEX IF EXISTS idx_orders_user_history;
