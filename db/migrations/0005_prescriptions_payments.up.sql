CREATE TYPE prescription_status AS ENUM ('draft', 'signed', 'voided');
CREATE TYPE payment_status AS ENUM (
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'partially_refunded'
);
CREATE TYPE payment_provider AS ENUM ('mock', 'razorpay', 'stripe');

CREATE TABLE prescriptions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctors (user_id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status prescription_status NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  diagnosis text,
  notes text,
  issued_at timestamptz,
  signed_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  document_url text,
  document_sha256 char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescriptions_consultation_version_unique UNIQUE (consultation_id, version),
  CONSTRAINT prescriptions_version_positive CHECK (version > 0),
  CONSTRAINT prescriptions_signed_requires_document CHECK (
    status <> 'signed'
    OR (
      issued_at IS NOT NULL
      AND signed_at IS NOT NULL
      AND document_url IS NOT NULL
      AND document_sha256 IS NOT NULL
    )
  ),
  CONSTRAINT prescriptions_voided_consistent CHECK (
    status <> 'voided'
    OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND signed_at IS NOT NULL)
  ),
  CONSTRAINT prescriptions_document_hash_hex CHECK (
    document_sha256 IS NULL OR document_sha256 ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX prescriptions_consultation_idx ON prescriptions (consultation_id);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);
CREATE INDEX prescriptions_doctor_idx ON prescriptions (doctor_id, created_at DESC);

CREATE TABLE prescription_items (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  prescription_id uuid NOT NULL REFERENCES prescriptions (id) ON DELETE CASCADE,
  medication_name text NOT NULL,
  dosage text NOT NULL,
  frequency text NOT NULL,
  duration_days smallint NOT NULL,
  instructions text,
  sort_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescription_items_medication_present CHECK (btrim(medication_name) <> ''),
  CONSTRAINT prescription_items_dosage_present CHECK (btrim(dosage) <> ''),
  CONSTRAINT prescription_items_frequency_present CHECK (btrim(frequency) <> ''),
  CONSTRAINT prescription_items_duration_range CHECK (duration_days BETWEEN 1 AND 365),
  CONSTRAINT prescription_items_sort_order_non_negative CHECK (sort_order >= 0),
  CONSTRAINT prescription_items_order_unique UNIQUE (prescription_id, sort_order)
);

CREATE INDEX prescription_items_prescription_idx ON prescription_items (prescription_id);

CREATE FUNCTION validate_prescription_participants() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  consultation_patient_id uuid;
  consultation_doctor_id uuid;
BEGIN
  SELECT patient_id, doctor_id
  INTO consultation_patient_id, consultation_doctor_id
  FROM consultations
  WHERE id = NEW.consultation_id;

  IF consultation_patient_id IS NULL THEN
    RAISE EXCEPTION 'consultation % does not exist', NEW.consultation_id
      USING ERRCODE = '23503';
  END IF;

  IF consultation_patient_id <> NEW.patient_id OR consultation_doctor_id <> NEW.doctor_id THEN
    RAISE EXCEPTION 'prescription participants do not match consultation %', NEW.consultation_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_prescription_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('signed', 'voided') THEN
      RAISE EXCEPTION 'prescription % cannot be deleted after signing', OLD.id
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('signed', 'voided') THEN
    -- The only permitted transition is signed -> voided, and it may only
    -- touch the void metadata.
    IF OLD.status = 'signed'
      AND NEW.status = 'voided'
      AND NEW.id = OLD.id
      AND NEW.consultation_id = OLD.consultation_id
      AND NEW.doctor_id = OLD.doctor_id
      AND NEW.patient_id = OLD.patient_id
      AND NEW.version = OLD.version
      AND NEW.diagnosis IS NOT DISTINCT FROM OLD.diagnosis
      AND NEW.notes IS NOT DISTINCT FROM OLD.notes
      AND NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at
      AND NEW.signed_at IS NOT DISTINCT FROM OLD.signed_at
      AND NEW.document_url IS NOT DISTINCT FROM OLD.document_url
      AND NEW.document_sha256 IS NOT DISTINCT FROM OLD.document_sha256
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'prescription % is immutable after signing', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_prescription_item_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id uuid;
  parent_status prescription_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.prescription_id;
  ELSE
    parent_id := NEW.prescription_id;
  END IF;

  SELECT status INTO parent_status FROM prescriptions WHERE id = parent_id;

  IF parent_status IN ('signed', 'voided') THEN
    RAISE EXCEPTION 'prescription items cannot change after signing (prescription %)', parent_id
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER prescriptions_validate_participants
BEFORE INSERT OR UPDATE OF consultation_id, doctor_id, patient_id ON prescriptions
FOR EACH ROW EXECUTE FUNCTION validate_prescription_participants();

CREATE TRIGGER prescriptions_enforce_immutability
BEFORE UPDATE OR DELETE ON prescriptions
FOR EACH ROW EXECUTE FUNCTION enforce_prescription_immutability();

CREATE TRIGGER prescriptions_set_updated_at
BEFORE UPDATE ON prescriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER prescription_items_enforce_immutability
BEFORE INSERT OR UPDATE OR DELETE ON prescription_items
FOR EACH ROW EXECUTE FUNCTION enforce_prescription_item_immutability();

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL,
  amount_refunded_cents integer NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'INR',
  status payment_status NOT NULL DEFAULT 'pending',
  provider payment_provider NOT NULL DEFAULT 'mock',
  provider_reference text,
  failure_code text,
  authorized_at timestamptz,
  captured_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT payments_refund_range CHECK (
    amount_refunded_cents >= 0 AND amount_refunded_cents <= amount_cents
  ),
  CONSTRAINT payments_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payments_captured_consistent CHECK (
    status <> 'captured' OR captured_at IS NOT NULL
  ),
  CONSTRAINT payments_refunded_consistent CHECK (
    status NOT IN ('refunded', 'partially_refunded')
    OR (
      refunded_at IS NOT NULL
      AND amount_refunded_cents > 0
      AND (status <> 'partially_refunded' OR amount_refunded_cents < amount_cents)
    )
  ),
  CONSTRAINT payments_provider_reference_unique UNIQUE (provider_reference)
);

CREATE UNIQUE INDEX payments_active_consultation_idx
  ON payments (consultation_id)
  WHERE status IN ('pending', 'authorized', 'captured', 'partially_refunded');

CREATE INDEX payments_patient_idx ON payments (patient_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status, created_at);
CREATE INDEX payments_provider_reference_idx
  ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE FUNCTION validate_payment_participants() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  consultation_patient_id uuid;
BEGIN
  SELECT patient_id INTO consultation_patient_id
  FROM consultations
  WHERE id = NEW.consultation_id;

  IF consultation_patient_id IS NULL THEN
    RAISE EXCEPTION 'consultation % does not exist', NEW.consultation_id
      USING ERRCODE = '23503';
  END IF;

  IF consultation_patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'payment patient does not match consultation %', NEW.consultation_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_validate_participants
BEFORE INSERT OR UPDATE OF consultation_id, patient_id ON payments
FOR EACH ROW EXECUTE FUNCTION validate_payment_participants();

CREATE TRIGGER payments_set_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
