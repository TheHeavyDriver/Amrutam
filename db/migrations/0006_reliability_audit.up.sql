CREATE TYPE idempotency_status AS ENUM ('in_progress', 'completed', 'failed');
CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'dispatched', 'failed', 'dead_letter');

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  actor_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_method text NOT NULL,
  request_path text NOT NULL,
  request_hash char(64) NOT NULL,
  status idempotency_status NOT NULL DEFAULT 'in_progress',
  response_status smallint,
  response_body jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT idempotency_actor_key_unique UNIQUE (actor_id, idempotency_key),
  CONSTRAINT idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 8 AND 255),
  CONSTRAINT idempotency_method_valid CHECK (request_method ~ '^[A-Z]{2,16}$'),
  CONSTRAINT idempotency_path_length CHECK (char_length(request_path) BETWEEN 1 AND 2048),
  CONSTRAINT idempotency_hash_hex CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_response_status_range CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  CONSTRAINT idempotency_completed_has_response CHECK (
    status <> 'completed' OR response_status IS NOT NULL
  ),
  CONSTRAINT idempotency_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);
CREATE INDEX idempotency_in_progress_idx
  ON idempotency_keys (locked_until)
  WHERE status = 'in_progress';

CREATE TRIGGER idempotency_keys_set_updated_at
BEFORE UPDATE ON idempotency_keys
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status outbox_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_aggregate_type_present CHECK (btrim(aggregate_type) <> ''),
  CONSTRAINT outbox_event_type_present CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_dispatched_consistent CHECK (
    status <> 'dispatched' OR dispatched_at IS NOT NULL
  )
);

CREATE INDEX outbox_dispatch_idx
  ON outbox_events (available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX outbox_processing_idx
  ON outbox_events (locked_at)
  WHERE status = 'processing';
CREATE INDEX outbox_aggregate_idx ON outbox_events (aggregate_type, aggregate_id, created_at DESC);

CREATE TABLE audit_logs (
  id uuid NOT NULL DEFAULT uuid_v7(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role user_role,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_id text,
  source_ip inet,
  user_agent text,
  before_hash char(64),
  after_hash char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash char(64),
  entry_hash char(64) NOT NULL,
  CONSTRAINT audit_logs_pk PRIMARY KEY (id, occurred_at),
  CONSTRAINT audit_logs_action_present CHECK (btrim(action) <> ''),
  CONSTRAINT audit_logs_resource_type_present CHECK (btrim(resource_type) <> ''),
  CONSTRAINT audit_logs_resource_id_present CHECK (btrim(resource_id) <> ''),
  CONSTRAINT audit_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_logs_hashes_hex CHECK (
    entry_hash ~ '^[0-9a-f]{64}$'
    AND (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$')
    AND (before_hash IS NULL OR before_hash ~ '^[0-9a-f]{64}$')
    AND (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$')
  )
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_logs_resource_idx
  ON audit_logs (resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx
  ON audit_logs (actor_id, occurred_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_audit_log_partition(target_month date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start timestamptz := date_trunc('month', target_month)::timestamp AT TIME ZONE 'UTC';
  month_end timestamptz :=
    (date_trunc('month', target_month) + interval '1 month')::timestamp AT TIME ZONE 'UTC';
  partition_name text := format('audit_logs_%s', to_char(target_month, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    month_start,
    month_end
  );

  RETURN partition_name;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_audit_log_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  month_offset integer;
BEGIN
  IF months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 24';
  END IF;

  FOR month_offset IN 0..months_ahead LOOP
    PERFORM ensure_audit_log_partition(
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date
    );
  END LOOP;

  RETURN months_ahead + 1;
END;
$$;

SELECT ensure_audit_log_partition(
  (date_trunc('month', current_date) - interval '1 month')::date
);
SELECT ensure_audit_log_partitions(3);

CREATE FUNCTION prevent_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
