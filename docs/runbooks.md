# Operational runbooks

Use these with the Prometheus alerts in `infra/observability/prometheus/alerts.yml` and the dashboard `amrutam-overview`. Never paste PHI, tokens, or secrets into incident channels. Logs are structured JSON; request IDs are the primary correlation key, trace IDs when OTel is enabled.

## First 5 minutes (all incidents)

1. Check `GET /health/ready` and the **API/worker down** panels.
2. Identify scope: all traffic, one route, one deployment, one shard/partition, or asynchronous work only.
3. Check recent deploys, migrations, secret rotations, and infrastructure changes.
4. Capture the alert window, request IDs/trace IDs, and error codes. Do not dump patient payloads.
5. If patient safety or data integrity is at risk, freeze writes (scale API/worker to zero) and escalate per the clinical incident policy.

## API down

**Symptoms:** `AmrutamApiDown`, connection failures, readiness 503.

1. `kubectl -n amrutam get pods,deploy,svc` and `kubectl describe pod`.
2. Check readiness reason; if PostgreSQL is unavailable, go to **database unavailable**.
3. Check the last deploy: `kubectl rollout history deployment/amrutam-api`.
4. If the new revision is unhealthy, `kubectl rollout undo deployment/amrutam-api` and repeat for the worker only if the worker is affected.
5. Verify `/health/ready` and a doctor search. Watch 5xx and latency for 10 minutes.
6. If credentials were rotated, confirm the ExternalSecret synced and env vars are present, then restart pods.

## Database unavailable

1. Check RDS events/status and Multi-AZ failover; check security-group and secret changes.
2. The API pool uses bounded connections and a 5 s connect timeout; readiness fails fast.
3. If failover is in progress, wait for DNS/endpoint update and confirm API reconnects without a deploy.
4. If the primary is lost, follow [backup-dr.md](backup-dr.md) for PITR/promotion. Do not edit audit records.
5. After recovery, verify outbox lag, audit chain, and booking/payment smoke tests.

## High error rate

1. Break down by route template and status on the dashboard; inspect errors by `requestId`.
2. 4xx spikes usually mean client contract drift, rate limits, expired tokens, or validation changes.
3. 5xx spikes: check database saturation, lock waits, recent migrations, payment provider responses, and worker/outbox state.
4. If a single deployment is bad, roll back. If a dependency is bad, enable degradation (cache fail-open is automatic; consider disabling a non-critical analytics route).
5. File a follow-up with the failing request IDs and error codes; avoid storing response bodies containing PHI.

## High latency

1. Compare read vs write p95, then per-route p95.
2. Check PostgreSQL CPU, connection count, lock waits, and slow queries; check Redis latency/errors.
3. Confirm the pool is not exhausted (`DATABASE_POOL_MAX`); scale API/PgBouncer if pool waits dominate.
4. For booking spikes, inspect slot-row and patient advisory-lock waits; do not bypass locks.
5. Analytics queries are capped at 366 days and use indexed predicates; move them to a read replica if they contend with writes.
6. Add an index only through a new migration; never `CREATE INDEX` manually in production without recording it.

## Worker down

**Symptoms:** `AmrutamWorkerDown`, no reminder/refund/no-show progress, pending outbox depth rising.

1. `kubectl -n amrutam logs deploy/amrutam-worker --tail=200`.
2. Check the worker metrics endpoint `:9464/health/live` and `/metrics`.
3. If the worker pods are crash-looping on a bad event, events retry and eventually dead-letter; the API remains available.
4. Restart/scale the deployment. Multiple replicas are safe due to `SKIP LOCKED` and advisory locks.
5. Confirm backlog drains and no new dead letters appear.
6. Refunds are eventually consistent: if the outage exceeds the customer policy window, escalate to support and use the payment ledger/provider dashboard; do not manually update `payments` without an audited admin refund.

## Outbox backlog

1. Check pending vs processing vs dead-letter, worker replica health, and handler error rates.
2. A temporarily high backlog after a burst is normal within the 1 s polling interval.
3. If one event type fails repeatedly, find its IDs and error messages via logs/metrics; fix the root cause before replaying.
4. Scale workers for throughput, but keep DB connection budgets in mind.
5. Do not delete pending events.

## DLQ

**Alert:** `AmrutamDeadLetterEvents` (any dead-letter event is critical).

1. Inspect without payload exposure:
   ```bash
   npm run jobs:status
   # or in a container:
   node dist/jobs/cli.js status --limit 20
   ```
2. Identify the event type, aggregate ID, attempts, and sanitized error. Correlate with request/audit records.
3. Fix the root cause (provider outage, malformed producer event, code bug).
4. Replay one event first:
   ```bash
   node dist/jobs/cli.js replay --id <uuid>
   ```
5. Watch it dispatch and verify the downstream effect (refund ledger/audit). Then replay all:
   ```bash
   node dist/jobs/cli.js replay --all --limit 100
   ```
6. Handlers are idempotent; a replay may return a no-op if the effect already committed. Never edit `outbox_events` directly unless an incident commander approves and records the SQL.
7. If poison messages recur, disable the producer path or add validation before re-enabling.

## Deploy and rollback

1. CI must be green: format, lint, typecheck, build, contract check, tests, scans.
2. Build/push an immutable image tagged with the commit SHA.
3. Run the migration job **before** the rollout and wait for completion. Migrations are reversible and checksum-locked; do not run from multiple pipelines.
4. Apply the staging overlay and wait for `kubectl rollout status` on API and worker.
5. Run smoke tests: `/health/ready`, doctor search, a booking (test patient), and an authenticated read.
6. Watch error rate/latency/outbox for 15 minutes.
7. Roll back application deployments with `kubectl rollout undo`. Database rollback requires an explicit decision: the previous app must remain compatible with the migrated schema; use `node dist/database/cli.js down` only for a migration that is known-safe to reverse.
8. After rollback, verify provider webhooks and queued refunds are still processed.

## Migration failure

1. The runner is transactional and advisory-locked; a failed migration rolls back.
2. Read the exact error, inspect the paired `.up.sql`/`.down.sql`, and fix forward with a **new** migration.
3. Never edit an applied migration: checksums will fail.
4. If a migration is stuck waiting on a lock, find the blocking session (`pg_blocking_pids`) and resolve it; do not kill the migration blindly.
5. Re-run the deploy gate and verify `db status` has no pending migrations before rollout.

## Secret rotation

1. Add the new secret at the provider/secret manager; keep the old value valid during a dual-verify window where supported.
2. Update the ExternalSecret/Secret and restart pods.
3. JWT access keys: accept old+new during the access-token TTL, then retire old.
4. Refresh/verification/reset tokens: rotating `AUTH_TOKEN_PEPPER` invalidates all opaque tokens; announce a re-login.
5. `AUTH_ENCRYPTION_KEY` rotation requires re-encryption of TOTP secrets and stored encrypted tokens. Do not rotate without a migration/runbook; test on a restore copy first.
6. `PAYMENT_WEBHOOK_SECRET`: configure the provider for dual signing, deploy verification support, then retire the old secret.
7. Database/Redis credentials: use managed rotation, update the secret store, restart pods, and verify connection pools.

## Security incident

1. Preserve evidence; do not delete logs or database snapshots.
2. Revoke affected sessions, rotate secrets, and isolate the pod/node if compromised.
3. Check admin audit records, verification changes, payment refunds, prescription downloads, and outbox replays.
4. Validate the audit chain before and after containment; export chain head to WORM storage.
5. Notify per legal/compliance policy. Do not discuss PHI in public channels.

## Useful commands

```bash
curl -fsS https://api.example.com/health/ready
kubectl -n amrutam rollout status deploy/amrutam-api
kubectl -n amrutam logs deploy/amrutam-api --since=15m
kubectl -n amrutam logs deploy/amrutam-worker --since=15m
npm run jobs:status
npm run jobs:replay -- --id <uuid>
node dist/database/cli.js status
psql "$DATABASE_URL" -c "select status, count(*) from outbox_events group by status;"
```
