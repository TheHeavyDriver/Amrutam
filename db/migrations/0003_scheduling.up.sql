CREATE TYPE slot_status AS ENUM ('available', 'held', 'booked', 'blocked');

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  doctor_id uuid NOT NULL REFERENCES doctors (user_id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status slot_status NOT NULL DEFAULT 'available',
  hold_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_slots_doctor_start_unique UNIQUE (doctor_id, starts_at),
  CONSTRAINT availability_slots_time_order CHECK (ends_at > starts_at),
  CONSTRAINT availability_slots_duration CHECK (
    ends_at >= starts_at + interval '5 minutes'
    AND ends_at <= starts_at + interval '4 hours'
  ),
  CONSTRAINT availability_slots_hold_consistent CHECK (
    (status = 'held' AND hold_expires_at IS NOT NULL)
    OR (status <> 'held' AND hold_expires_at IS NULL)
  ),
  -- The database, not the application, is the final authority against
  -- overlapping slots for the same doctor.
  CONSTRAINT availability_slots_no_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);

CREATE INDEX availability_slots_booking_idx
  ON availability_slots (doctor_id, starts_at)
  INCLUDE (ends_at, status, hold_expires_at);

CREATE INDEX availability_slots_available_idx
  ON availability_slots (starts_at)
  WHERE status = 'available';

CREATE INDEX availability_slots_hold_expiry_idx
  ON availability_slots (hold_expires_at)
  WHERE status = 'held';

CREATE TRIGGER availability_slots_set_updated_at
BEFORE UPDATE ON availability_slots
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
