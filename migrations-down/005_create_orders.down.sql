-- Manual rollback for 005 (NOT auto-applied). Roll back 007 and 006 first.
--   DELETE FROM schema_migrations WHERE name = '005_create_orders.sql';
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP SEQUENCE IF EXISTS order_number_seq;
