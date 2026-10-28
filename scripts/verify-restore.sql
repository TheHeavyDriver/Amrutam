\echo 'Restore verification: pending migrations'
SELECT count(*) AS applied_migrations FROM schema_migrations;

\echo 'Restore verification: core row counts'
SELECT 'users' AS table_name, count(*) FROM users
UNION ALL SELECT 'doctors', count(*) FROM doctors
UNION ALL SELECT 'availability_slots', count(*) FROM availability_slots
UNION ALL SELECT 'consultations', count(*) FROM consultations
UNION ALL SELECT 'prescriptions', count(*) FROM prescriptions
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'payment_refunds', count(*) FROM payment_refunds
UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
UNION ALL SELECT 'outbox_events', count(*) FROM outbox_events;

\echo 'Restore verification: active consultations without slot claim (must be 0)'
SELECT count(*) AS consultations_without_claim
  FROM consultations c
  LEFT JOIN consultation_slot_claims claim ON claim.consultation_id = c.id
 WHERE c.status IN ('scheduled', 'in_progress', 'completed')
   AND claim.consultation_id IS NULL;

\echo 'Restore verification: over-refunded payments (must be 0)'
SELECT count(*) AS over_refunded_payments
  FROM (
    SELECT p.id, p.amount_cents, COALESCE(sum(r.amount_cents), 0) AS refunded_cents
      FROM payments p
      LEFT JOIN payment_refunds r ON r.payment_id = p.id
     GROUP BY p.id, p.amount_cents
  ) totals
 WHERE refunded_cents > amount_cents;

\echo 'Restore verification: broken audit hash links (must be 0)'
WITH links AS (
  SELECT occurrence.occurred_at,
         occurrence.id,
         occurrence.previous_hash,
         lag(occurrence.entry_hash) OVER (ORDER BY occurrence.occurred_at, occurrence.id) AS expected_previous
    FROM audit_logs occurrence
)
SELECT count(*) AS broken_audit_links
  FROM links
 WHERE expected_previous IS NOT NULL
   AND previous_hash IS DISTINCT FROM expected_previous;

\echo 'Restore verification: outbox status summary'
SELECT status::text, count(*) FROM outbox_events GROUP BY status ORDER BY status;
