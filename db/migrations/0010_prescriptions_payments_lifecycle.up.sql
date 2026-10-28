-- Signed prescription artifacts are stored as immutable bytes with their
-- checksum. In production the same abstraction can be backed by object
-- storage; keeping the bytes transactionally attached to the signature makes
-- local and test deployments self-contained.
CREATE TABLE prescription_documents (
  prescription_id uuid PRIMARY KEY REFERENCES prescriptions (id) ON DELETE RESTRICT,
  content_type text NOT NULL,
  content bytea NOT NULL,
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescription_documents_content_type_present CHECK (btrim(content_type) <> ''),
  CONSTRAINT prescription_documents_content_present CHECK (octet_length(content) > 0),
  CONSTRAINT prescription_documents_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION prevent_prescription_document_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'signed prescription documents are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER prescription_documents_append_only
BEFORE UPDATE OR DELETE ON prescription_documents
FOR EACH ROW EXECUTE FUNCTION prevent_prescription_document_mutation();

-- A consultation can have multiple signed prescription versions over time,
-- but only one editable draft at a time.
CREATE UNIQUE INDEX prescriptions_one_draft_idx
  ON prescriptions (consultation_id)
  WHERE status = 'draft';

CREATE INDEX prescriptions_consultation_created_id_idx
  ON prescriptions (consultation_id, created_at DESC, id DESC);

CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL,
  reason text NOT NULL,
  provider_reference text,
  refunded_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_refunds_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT payment_refunds_reason_present CHECK (char_length(btrim(reason)) >= 3),
  CONSTRAINT payment_refunds_provider_reference_unique UNIQUE (provider_reference)
);

CREATE INDEX payment_refunds_payment_idx
  ON payment_refunds (payment_id, created_at DESC);

CREATE FUNCTION prevent_payment_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment ledger entries are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER payment_refunds_append_only
BEFORE UPDATE OR DELETE ON payment_refunds
FOR EACH ROW EXECUTE FUNCTION prevent_payment_ledger_mutation();

-- Provider callbacks are deduplicated by provider + event id. Only a hash of
-- the raw event body is retained; the body itself may contain sensitive data.
CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  provider payment_provider NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  payload_sha256 char(64) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_webhook_event_id_present CHECK (
    char_length(event_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT payment_webhook_event_type_present CHECK (
    char_length(event_type) BETWEEN 1 AND 100
  ),
  CONSTRAINT payment_webhook_payload_sha256_hex CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_webhook_provider_event_unique UNIQUE (provider, event_id)
);

CREATE INDEX payment_webhook_events_payment_idx
  ON payment_webhook_events (payment_id, received_at DESC);

CREATE TRIGGER payment_webhook_events_append_only
BEFORE UPDATE OR DELETE ON payment_webhook_events
FOR EACH ROW EXECUTE FUNCTION prevent_payment_ledger_mutation();
