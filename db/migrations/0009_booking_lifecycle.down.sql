DROP INDEX IF EXISTS consultations_start_id_idx;
DROP INDEX IF EXISTS consultations_doctor_start_id_idx;
DROP INDEX IF EXISTS consultations_patient_start_id_idx;
ALTER TABLE consultations DROP COLUMN IF EXISTS no_show_notes;
