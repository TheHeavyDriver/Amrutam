DROP INDEX IF EXISTS payment_refunds_created_at_idx;
DROP INDEX IF EXISTS payments_consultation_captured_idx;
DROP INDEX IF EXISTS payments_captured_at_idx;
DROP INDEX IF EXISTS availability_slots_start_status_idx;
DROP INDEX IF EXISTS users_role_created_at_idx;
DROP INDEX IF EXISTS doctors_admin_list_idx;

ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_verification_reason_length;
ALTER TABLE doctors DROP COLUMN IF EXISTS verification_reason;
