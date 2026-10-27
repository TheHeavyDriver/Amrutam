-- Preserve the optional no-show note separately from booking/clinical notes.
ALTER TABLE consultations ADD COLUMN no_show_notes text;

-- Cursor pagination orders by scheduled_start DESC, id DESC within the
-- patient/doctor access paths and across the admin view.
CREATE INDEX consultations_patient_start_id_idx
  ON consultations (patient_id, scheduled_start DESC, id DESC);
CREATE INDEX consultations_doctor_start_id_idx
  ON consultations (doctor_id, scheduled_start DESC, id DESC);
CREATE INDEX consultations_start_id_idx
  ON consultations (scheduled_start DESC, id DESC);
