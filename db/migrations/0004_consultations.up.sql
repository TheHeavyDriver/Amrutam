CREATE TYPE consultation_status AS ENUM (
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
  'no_show'
);

-- Hash partitioning keeps the primary key on id (so foreign keys stay simple)
-- while distributing writes. Time-based retention is applied to audit logs,
-- which are append-only and never referenced by foreign keys.
CREATE TABLE consultations (
  id uuid NOT NULL DEFAULT uuid_v7(),
  patient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctors (user_id) ON DELETE RESTRICT,
  slot_id uuid NOT NULL REFERENCES availability_slots (id) ON DELETE RESTRICT,
  status consultation_status NOT NULL DEFAULT 'scheduled',
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz NOT NULL,
  fee_cents integer NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'INR',
  started_at timestamptz,
  ended_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  cancellation_reason text,
  no_show_at timestamptz,
  join_token_hash text,
  join_token_expires_at timestamptz,
  notes text,
  diagnosis text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultations_pk PRIMARY KEY (id),
  CONSTRAINT consultations_time_order CHECK (scheduled_end > scheduled_start),
  CONSTRAINT consultations_fee_non_negative CHECK (fee_cents >= 0),
  CONSTRAINT consultations_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT consultations_join_token_consistent CHECK (
    (join_token_hash IS NULL) = (join_token_expires_at IS NULL)
  ),
  CONSTRAINT consultations_state_timestamps CHECK (
    (
      status = 'scheduled'
      AND started_at IS NULL
      AND ended_at IS NULL
      AND cancelled_at IS NULL
      AND cancelled_by_user_id IS NULL
      AND no_show_at IS NULL
    )
    OR (
      status = 'in_progress'
      AND started_at IS NOT NULL
      AND ended_at IS NULL
      AND cancelled_at IS NULL
      AND cancelled_by_user_id IS NULL
      AND no_show_at IS NULL
    )
    OR (
      status = 'completed'
      AND started_at IS NOT NULL
      AND ended_at IS NOT NULL
      AND ended_at >= started_at
      AND cancelled_at IS NULL
      AND cancelled_by_user_id IS NULL
      AND no_show_at IS NULL
    )
    OR (
      status = 'cancelled'
      AND cancelled_at IS NOT NULL
      AND cancelled_by_user_id IS NOT NULL
    )
    OR (
      status = 'no_show'
      AND started_at IS NULL
      AND ended_at IS NULL
      AND cancelled_at IS NULL
      AND cancelled_by_user_id IS NULL
      AND no_show_at IS NOT NULL
    )
  )
) PARTITION BY HASH (id);

DO $$
DECLARE
  partition_index integer;
BEGIN
  FOR partition_index IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF consultations FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      'consultations_p' || lpad(partition_index::text, 2, '0'),
      partition_index
    );
  END LOOP;
END;
$$;

CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_start DESC);
CREATE INDEX consultations_doctor_idx ON consultations (doctor_id, scheduled_start DESC);
CREATE INDEX consultations_status_idx ON consultations (status, scheduled_start);
CREATE INDEX consultations_slot_idx ON consultations (slot_id);

-- One row per booked slot. The primary key on slot_id is the database-level
-- guarantee that a slot can never back two consultations.
CREATE TABLE consultation_slot_claims (
  slot_id uuid PRIMARY KEY REFERENCES availability_slots (id) ON DELETE RESTRICT,
  consultation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_slot_claims_consultation_unique UNIQUE (consultation_id),
  CONSTRAINT consultation_slot_claims_consultation_fk
    FOREIGN KEY (consultation_id) REFERENCES consultations (id) ON DELETE CASCADE
);

CREATE FUNCTION enforce_consultation_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'cancelled', 'no_show') THEN
    RAISE EXCEPTION 'consultation % is in terminal state %', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled', 'no_show'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid consultation transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER consultations_enforce_transition
BEFORE UPDATE OF status ON consultations
FOR EACH ROW EXECUTE FUNCTION enforce_consultation_transition();

CREATE TRIGGER consultations_set_updated_at
BEFORE UPDATE ON consultations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION validate_consultation_slot_claim() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_slot_id uuid;
BEGIN
  SELECT slot_id INTO expected_slot_id
  FROM consultations
  WHERE id = NEW.consultation_id;

  IF expected_slot_id IS NULL THEN
    RAISE EXCEPTION 'consultation % does not exist', NEW.consultation_id
      USING ERRCODE = '23503';
  END IF;

  IF expected_slot_id <> NEW.slot_id THEN
    RAISE EXCEPTION 'slot claim % does not match consultation slot %',
      NEW.slot_id, expected_slot_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER consultation_slot_claims_validate
BEFORE INSERT OR UPDATE ON consultation_slot_claims
FOR EACH ROW EXECUTE FUNCTION validate_consultation_slot_claim();
