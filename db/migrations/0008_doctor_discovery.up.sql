-- Discovery reads verified doctors by rating, fee, and next availability, and
-- searches name/specialization/bio. Keep the supporting indexes targeted to
-- those access paths; partial indexes avoid indexing non-verified profiles.
CREATE INDEX doctors_bio_trgm_idx
  ON doctors USING gin (bio gin_trgm_ops)
  WHERE bio IS NOT NULL;

CREATE INDEX doctors_verified_rating_idx
  ON doctors (rating DESC, rating_count DESC, user_id)
  WHERE verification_status = 'verified';

CREATE INDEX doctors_verified_fee_idx
  ON doctors (consultation_fee_cents, user_id)
  WHERE verification_status = 'verified';

CREATE INDEX availability_slots_available_doctor_start_idx
  ON availability_slots (doctor_id, starts_at)
  WHERE status = 'available';
