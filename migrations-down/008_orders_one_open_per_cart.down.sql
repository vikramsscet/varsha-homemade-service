-- Manual rollback for 008 (NOT auto-applied).
--   DELETE FROM schema_migrations WHERE name = '008_orders_one_open_per_cart.sql';
DROP INDEX IF EXISTS uq_orders_one_open_per_cart;
