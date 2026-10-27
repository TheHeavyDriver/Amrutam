DROP TABLE IF EXISTS audit_logs CASCADE;
DROP FUNCTION IF EXISTS prevent_audit_log_mutation();
DROP FUNCTION IF EXISTS ensure_audit_log_partitions(integer);
DROP FUNCTION IF EXISTS ensure_audit_log_partition(date);
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS idempotency_keys;
DROP TYPE IF EXISTS outbox_status;
DROP TYPE IF EXISTS idempotency_status;
