ALTER TABLE doctors
  ADD COLUMN verification_reason text;

ALTER TABLE doctors
  ADD CONSTRAINT doctors_verification_reason_length CHECK (
    verification_reason IS NULL OR char_length(verification_reason) <= 500
  );

CREATE INDEX doctors_admin_list_idx
  ON doctors (created_at DESC, user_id DESC);

CREATE INDEX users_role_created_at_idx
  ON users (role, created_at DESC);

CREATE INDEX availability_slots_start_status_idx
  ON availability_slots (starts_at)
  INCLUDE (doctor_id, status);

CREATE INDEX payments_captured_at_idx
  ON payments (captured_at)
  WHERE captured_at IS NOT NULL;

CREATE INDEX payments_consultation_captured_idx
  ON payments (consultation_id, captured_at)
  WHERE captured_at IS NOT NULL;

CREATE INDEX payment_refunds_created_at_idx
  ON payment_refunds (created_at);
