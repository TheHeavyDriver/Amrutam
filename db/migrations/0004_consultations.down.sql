DROP TABLE IF EXISTS consultation_slot_claims CASCADE;
DROP TABLE IF EXISTS consultations CASCADE;
DROP FUNCTION IF EXISTS validate_consultation_slot_claim();
DROP FUNCTION IF EXISTS enforce_consultation_transition();
DROP TYPE IF EXISTS consultation_status;
