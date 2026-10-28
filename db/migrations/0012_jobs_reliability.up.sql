CREATE INDEX outbox_status_available_idx
  ON outbox_events (status, available_at, created_at);

CREATE INDEX outbox_dead_letter_idx
  ON outbox_events (available_at, created_at)
  WHERE status = 'dead_letter';

CREATE INDEX outbox_stale_processing_idx
  ON outbox_events (locked_at)
  WHERE status = 'processing';

CREATE TABLE consultation_reminders (
  consultation_id uuid NOT NULL REFERENCES consultations (id) ON DELETE CASCADE,
  reminder_type text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_reminders_pk PRIMARY KEY (consultation_id, reminder_type),
  CONSTRAINT consultation_reminders_type_valid CHECK (reminder_type IN ('24h', '1h'))
);

CREATE INDEX consultation_reminders_due_idx
  ON consultation_reminders (scheduled_for);
