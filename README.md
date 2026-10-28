# Amrutam Telemedicine Backend

Production-grade telemedicine backend for the assignment in [`description.md`](description.md). It implements identity and MFA, doctor discovery and availability, idempotent booking, consultation lifecycle, signed prescriptions, payments/refunds, tamper-evident audit, admin verification and analytics, a transactional outbox worker, observability, IaC, tests, and security documentation.

**Status:** all seven deliverables are present: runnable code, IaC, OpenAPI contract, architecture document, reproducible tests/CI, observability, and the security package. See the [deliverables map](#deliverables) and [known limitations](#known-limitations).

## Stack

| Concern       | Choice                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| Runtime       | Node.js 22+ (ESM), TypeScript                                                 |
| HTTP          | NestJS 12 + Fastify 5                                                         |
| Validation    | Zod, strict schemas                                                           |
| Data          | PostgreSQL 16, SQL-first migrations, `pg` (no ORM)                            |
| Cache         | Redis 7, fail-open cache-aside for public doctor data                         |
| Async         | PostgreSQL transactional outbox + separate worker process                     |
| API contract  | OpenAPI 3.1, Redocly lint, generated TypeScript client                        |
| Auth          | Argon2id, short JWT access tokens, rotating refresh tokens, TOTP MFA          |
| Observability | pino logs, Prometheus metrics, optional OpenTelemetry → Tempo/Loki/Grafana    |
| Tests         | Vitest + SWC; 18 suites / 111 passing tests (unit + e2e)                      |
| Deployment    | Docker, Docker Compose, Terraform (AWS), Kubernetes/Kustomize, GitHub Actions |

## Deliverables

| Deliverable                             | Location                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Code                                    | `src/`, `db/`, `test/`, `clients/`                                                                              |
| Setup                                   | this README, `Makefile`, `.env.example`                                                                         |
| OpenAPI schema                          | [`openapi/openapi.yaml`](openapi/openapi.yaml), 56 operations                                                   |
| Architecture (2–4 pages, diagrams, ERD) | [`docs/architecture.md`](docs/architecture.md)                                                                  |
| Tests + CI                              | [`test/`](test), [`.github/workflows/ci.yml`](.github/workflows/ci.yml), [CodeQL](.github/workflows/codeql.yml) |
| Observability                           | [`infra/observability/`](infra/observability), dashboards, alerts, runbooks                                     |
| Security checklist + STRIDE             | [`docs/security.md`](docs/security.md)                                                                          |
| IaC                                     | [`infra/terraform/`](infra/terraform), [`infra/k8s/`](infra/k8s)                                                |
| Backup/DR                               | [`docs/backup-dr.md`](docs/backup-dr.md), `scripts/restore-drill.sh`                                            |
| Runbooks                                | [`docs/runbooks.md`](docs/runbooks.md)                                                                          |
| Load tests                              | [`load/k6/`](load/k6)                                                                                           |
| Demo                                    | [`scripts/demo.sh`](scripts/demo.sh)                                                                            |

## Architecture at a glance

```text
clients ──HTTPS/JWT──> ingress ──> API replicas (NestJS/Fastify)
                                    │        │
                                    │        └── Redis (public doctor cache)
                                    └──────────> PostgreSQL 16 (primary + replicas)
                                                     ▲
worker replicas ──outbox / scheduled jobs────────────┘
      │
      └── OTLP → collector → Tempo / Loki / Prometheus → Grafana
```

- Deny-by-default JWT + RBAC guards; service-level ownership and state checks.
- No dual writes: clinical state, audit, and outbox events commit in one PostgreSQL transaction.
- Idempotent retry-sensitive domain writes (availability, booking, consultation, prescription, payment, admin verification) with transactional replay and request fingerprints.
- Booking protected by row locks, patient-overlap locks, a unique slot claim, and a GiST exclusion constraint.
- Cancellation creates an asynchronous refund saga; the worker retries with exponential backoff + jitter and parks poison events in a DLQ.
- `consultations` is hash-partitioned; `audit_logs` is range-partitioned and hash-chained.

Full design: [`docs/architecture.md`](docs/architecture.md).

## Quick start

Prerequisites: Node.js 22+, npm, Docker with Compose v2.

```bash
cp .env.example .env
npm run env:secrets      # fills local random secrets without printing them
npm install
make up                  # Postgres, Redis, OTel collector, Tempo, Loki, Prometheus, Grafana
make db-migrate
make db-seed
npm run start:dev        # API on http://localhost:3000
npm run jobs:run         # in another terminal: outbox + scheduled jobs
```

Verify:

```bash
curl -fsS http://localhost:3000/health/ready
curl -fsS 'http://localhost:3000/api/v1/doctors?limit=2' | jq
```

Or run the complete containerized demo (builds, migrates, seeds, then starts API + worker + observability):

```bash
make app
```

The Compose API/worker read `.env` (for auth/payment secrets) and override database/Redis URLs to the Compose network. Ports are defined in `.env`; defaults are 5432 for PostgreSQL, 6379 for Redis, 3000 for the API, 3001 for Grafana.

### Demo credentials

The seed prints these values:

- Password for every seeded account: `DemoPass!2026`
- TOTP secret for seeded doctors/admins: `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`
- Admin: `admin@amrutam.local`
- Doctors: e.g. `aarav.mehta@amrutam.local` (Cardiology)
- Patients: `patient1@amrutam.local` … `patient20@amrutam.local`

These credentials are local-only. Never use them outside a disposable demo environment.

## API

The contract is the source of truth: [`openapi/openapi.yaml`](openapi/openapi.yaml). It covers 56 operations and includes the shared error envelope, idempotency headers, rate-limit headers, cursor pagination, UTC timestamps, and integer minor-unit money.

Key groups:

| Group         | Examples                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| Health        | `/health`, `/health/live`, `/health/ready`                                                                      |
| Auth/MFA      | register, login, refresh, logout, email verification, password reset, TOTP setup/enable/disable, MFA verify     |
| Users         | `GET/PATCH /api/v1/users/me`, change password                                                                   |
| Doctors       | search, detail, public availability, authenticated own-availability list/create/remove                          |
| Bookings      | create, list/detail, cancel, reschedule, join-token, start, complete, no-show                                   |
| Prescriptions | draft/update, sign, void, list/detail, signed document content                                                  |
| Payments      | intent, confirm, read/list, refund, HMAC provider webhooks                                                      |
| Admin         | doctor list/verification, analytics overview/consultations/revenue/utilization/specialties, audit search/verify |

Public routes are deliberately narrow: health/metrics (ops), registration/login/refresh/recovery/MFA challenge, doctor discovery/availability, and payment webhooks (HMAC capability). Everything else requires a bearer token.

Example patient journey:

```bash
BASE=http://localhost:3000/api/v1
TOKEN=$(curl -fsS -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"email":"patient1@amrutam.local","password":"DemoPass!2026"}' | jq -r .accessToken)

DOCTOR=$(curl -fsS "$BASE/doctors?specialization=Cardiology&limit=1" | jq -r '.data[0].id')
FROM=$(node -e 'console.log(new Date().toISOString())')
TO=$(node -e 'console.log(new Date(Date.now() + 7 * 86400000).toISOString())')
SLOT=$(curl -fsS "$BASE/doctors/$DOCTOR/availability?from=$(jq -rn --arg v "$FROM" '$v|@uri')&to=$(jq -rn --arg v "$TO" '$v|@uri')&limit=1" | jq -r '.data[0].id')

CONSULT=$(curl -fsS -X POST "$BASE/bookings" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: demo-$(date +%s)" \
  -d "{\"slotId\":\"$SLOT\"}" | jq -r .id)

curl -fsS -X POST "$BASE/bookings/$CONSULT/payments" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: pay-$(date +%s)" \
  -d '{"provider":"mock"}' | jq
```

Retry-sensitive domain writes (availability, bookings, consultations, prescriptions, payments, admin verification) require `Idempotency-Key`. Repeat a request with the same key and body to get the original response (`Idempotency-Replayed: true`); reuse the key with a different body and the API returns `422 IDEMPOTENCY_KEY_REUSED`.

Doctors manage one-off availability with `GET/POST /doctors/me/availability` and `DELETE /doctors/me/availability/{slotId}` (doctor JWT required). Slots must start in the future, be 5 minutes–4 hours long, and cannot overlap; only `available` slots can be removed.

Run the complete scripted journey (login → search → availability → booking → mock payment → cancellation) against a seeded API:

```bash
API_BASE_URL=http://localhost:3000 ./scripts/demo.sh
```

The script prints the created IDs/statuses. With the worker running, the cancellation's `payment.refund_requested` outbox event is processed into the refund ledger and audit trail.

Generated client:

```bash
npm run api:validate   # Redocly
npm run api:generate   # regenerate clients/typescript/generated/api.ts
npm run api:check      # validate + typecheck generated client
```

## Configuration

Configuration is validated at startup with Zod; missing/weak secrets fail fast. The full list is in [`.env.example`](.env.example). Important values:

| Variable                                                                                                    | Default            | Notes                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `DATABASE_URL` / `DATABASE_POOL_MAX`                                                                        | local / `10`       | PostgreSQL; use PgBouncer at sustained scale                        |
| `REDIS_URL` / `CACHE_ENABLED`                                                                               | local / `true`     | Cache is optional and fail-open                                     |
| `JWT_ACCESS_SECRET`, `JWT_MFA_SECRET`, `AUTH_TOKEN_PEPPER`, `AUTH_ENCRYPTION_KEY`, `PAYMENT_WEBHOOK_SECRET` | required           | Independent high-entropy secrets; encryption key is base64 32 bytes |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`                                                                           | `true`             | Set `false` only for local/test without an email adapter            |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                                                                             | `900`              | Access tokens                                                       |
| `AUTH_REFRESH_TOKEN_TTL_SECONDS`                                                                            | `2592000`          | Rotating refresh sessions                                           |
| `PRESCRIPTION_DOCUMENT_URL_TTL_SECONDS`                                                                     | `300`              | Signed capability URL TTL                                           |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS`                                                              | `300` / `60`       | Global per-IP limit                                                 |
| `OUTBOX_*`, `SCHEDULER_INTERVAL_MS`                                                                         | see `.env.example` | Worker retry/backoff/batch tuning                                   |
| `WORKER_METRICS_PORT`                                                                                       | `9464`             | Worker health/metrics server                                        |
| `OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT`                                                              | `false` / local    | Enable tracing; Compose enables it                                  |

Generate local secrets:

```bash
npm run env:secrets
```

The script only fills empty values in `.env`, never overwrites existing values, and does not print them. In production, use AWS Secrets Manager + External Secrets/Sealed Secrets; do not deploy env files.

## Database and migrations

Migrations are paired, reversible SQL files in `db/migrations/`. The runner checksums both directions, takes a PostgreSQL advisory lock, and applies each migration transactionally. Never edit an applied migration.

```bash
npm run db:migrate
npm run db:status
npm run db:rollback                 # one step
npm run db:rollback -- --steps 3
npm run db:seed
```

Production images include the migration CLI and `db/` directory:

```bash
node dist/database/cli.js up
```

The seed refuses to run in production unless `SEED_ALLOW=true`. It is deterministic and safe to run after a reset. `consultations` is hash-partitioned (16 partitions). `audit_logs` is monthly range-partitioned; the worker pre-creates partitions.

## Worker, outbox, and scheduled jobs

```bash
npm run jobs:run                 # local worker
npm run jobs:start               # compiled worker (dist/worker.js)
npm run jobs:status              # backlog + dead-letter inspection
npm run jobs:replay -- --id ID   # replay one dead-letter event
npm run jobs:replay -- --all     # replay up to 1000
```

The worker processes `notification.email`, `consultation.reminder_due`, `payment.refund_requested`, and other domain events. The default notification adapter is a PHI-safe logging boundary; plug in SES/Twilio/FCM for real delivery. Scheduled jobs cover reminders, no-show detection, expired slot holds, cancellation refund reconciliation, audit partitions, and idempotency cleanup. All scheduled jobs use advisory locks so replicas are safe.

Observable metrics include outbox pending/processing/dead-letter depth, processed outcomes, and business event counters.

## Testing and CI

```bash
npm test              # pretest migrates, resets, and seeds the dedicated test DB
npm run test:unit
npm run test:e2e
npm run test:cov
```

`npm test` refuses a database URL that does not look like a test database. It runs 18 suites / 111 tests. Provide one:

```bash
TEST_DATABASE_URL=postgresql://amrutam:amrutam@localhost:5432/amrutam_test npm test
```

The pretest script runs migrations up, truncates all public tables except `schema_migrations`, and reseeds. Tests run sequentially because suites share seeded slot inventory. Coverage currently concentrates on e2e behavior: auth/session/MFA, idempotency/concurrency, booking/reschedule/cancel, prescriptions, payments/webhooks/refunds, admin verification, analytics, outbox/DLQ, metrics, and health.

Local quality gate:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run build
npm run api:check
npm test
```

GitHub Actions runs the same checks with PostgreSQL/Redis services, plus `npm audit`, gitleaks, Trivy filesystem/image scans, SBOM generation, dependency review, and CodeQL. The runtime image is a non-root Node 22 Alpine image with npm/npx/yarn removed, so package-manager tooling and its bundled dependencies are not shipped. `cd-staging.yml` builds an immutable image, runs the migration Job, deploys Kustomize, smoke-tests, and rolls back the Deployments on failure.

## Observability

| Signal                | Where                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| API metrics           | `GET /metrics` on the API (Prometheus scrape; restrict at the network edge)                              |
| Worker metrics/health | `http://worker:9464/metrics`, `/health/live`                                                             |
| Dashboard             | Grafana → Amrutam → **Amrutam — API and worker overview** (`http://localhost:3001`, local `admin/admin`) |
| Alerts                | [`infra/observability/prometheus/alerts.yml`](infra/observability/prometheus/alerts.yml)                 |
| Traces                | Tempo, collected from API and worker OTLP (`OTEL_ENABLED=true`)                                          |
| Logs                  | Loki, structured pino JSON; request IDs/trace IDs                                                        |

Alerts cover API/worker down, 5xx ratio >1%, GET p95 >200 ms, write p95 >500 ms, outbox backlog >100, and any dead-letter event. Metric labels use Fastify route templates to avoid cardinality explosion.

Enable tracing locally:

```bash
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run start:dev
```

Trace auto-instrumentation covers HTTP, PostgreSQL, and Redis. Outbox processing starts an `outbox.process` span with event ID/type attributes, so worker activity can be correlated with the outbox record. Producer-to-worker trace-context linking across the async boundary is a future enhancement.

## Security

The security package is [`docs/security.md`](docs/security.md). Highlights:

- Deny-by-default JWT + roles guards and explicit `@Public` allowlist.
- Argon2id passwords, distinct MFA JWT secret, HMAC-hashed rotating refresh tokens with reuse detection, TOTP and recovery codes, account lockout, session revocation.
- AES-256-GCM TOTP secrets; HMAC domain separation for refresh tokens, verification tokens, and prescription capability URLs.
- PostgreSQL parameterisation, strict Zod validation, server-derived fees, append-only refunds, provider webhook raw-body HMAC + event dedupe.
- Hash-chained audit logs with before/after hashes and PHI-free metadata. State change, audit, and outbox commit atomically.
- Secret hygiene: no defaults, startup fail-fast, `.env` ignored, TLS managed data services, KMS in Terraform, External Secrets in Kubernetes.
- CI security gates: audit, gitleaks, Trivy, SBOM, CodeQL, dependency review.

Residual risks are listed in the security document: no bundled email provider, global (not per-endpoint) rate limit, application-level audit anchoring to WORM, mock payment adapter, and no field-level encryption for free-text clinical notes. These are explicit production integration items, not silent omissions.

## Deployment and IaC

Terraform (`infra/terraform`) provisions VPC, Multi-AZ RDS PostgreSQL with PITR/KMS, Multi-AZ ElastiCache Redis, secrets, S3 exports, alarms, and security groups.

Kubernetes (`infra/k8s`) deploys non-root API/worker Deployments with read-only root filesystems, HPA, PDB, probes, topology spread, ingress, and ingress network policies. The CD workflow applies a separate migration Job and waits for completion before rolling out the staging overlay.

```bash
cd infra/terraform
terraform init && terraform validate && terraform plan

cd ../..
kubectl apply -k infra/k8s/overlays/staging
```

See [`infra/terraform/README.md`](infra/terraform/README.md) and [`infra/k8s/README.md`](infra/k8s/README.md). Backup/restore: [`docs/backup-dr.md`](docs/backup-dr.md). Incident/DLQ/deploy runbooks: [`docs/runbooks.md`](docs/runbooks.md).

## Performance and scale

- Target 100k consultations/day, p95 reads <200 ms, p95 writes <500 ms, 99.95% availability.
- k6 scenario: [`load/k6/booking-flow.js`](load/k6/booking-flow.js) with browse and book/cancel thresholds.
- Read replicas, connection pooling/PgBouncer, HPA, partition pruning, bounded date ranges, cache-aside, and indexed analytics paths.
- The outbox polling interval, batch size, retry cap, and lock recovery are configurable.

Run k6 against a fresh seeded environment:

```bash
API_BASE_URL=http://localhost:3000 k6 run load/k6/booking-flow.js
```

## Project layout

```text
src/
  cache/          # fail-open Redis cache
  common/         # guards, filters, idempotency, auth/security primitives, logging
  config/         # Zod environment schema + typed config
  database/       # pool, migration runner/CLI, deterministic seed
  metrics/        # Prometheus registry, HTTP/outbox metrics, /metrics
  modules/        # auth, users, doctors, bookings, prescriptions, payments,
                  # admin, analytics, audit, health, jobs
  instrumentation.ts # optional OTel SDK initialization
  worker.ts       # outbox/scheduler worker entrypoint
  main.ts         # API entrypoint
db/migrations/    # paired reversible SQL
openapi/          # OpenAPI 3.1 contract
clients/typescript# generated typed client
test/             # e2e suites, reset/seed pretest, test app factory
infra/            # Terraform, Kubernetes, observability
load/k6/          # load scenarios
docs/             # architecture, security, backup/DR, runbooks, ADRs
```

## Known limitations

These are explicitly out of scope or need production integration; see [security.md](docs/security.md#8-residual-risks-and-explicit-non-goals):

1. The notification adapter logs PHI-safe delivery metadata; no real email/SMS vendor is configured.
2. The payment provider is a local mock/ledger. Production must implement idempotent provider authorise/capture/refund calls and secret rotation.
3. Rate limiting is global per IP. Add edge/WAF and per-endpoint limits before exposure to hostile traffic.
4. Audit chain is internal to PostgreSQL; anchor chain heads to external WORM storage for stronger non-repudiation.
5. Analytics use indexed queries rather than materialised rollups; add read replicas/rollups as data volume grows.
6. k6 and restore drills are documented and scripted but were not executed against a provisioned multi-AZ AWS environment as part of this repository.

## Documentation

- [Architecture](docs/architecture.md)
- [Security, STRIDE, OWASP, data classification](docs/security.md)
- [Backup and disaster recovery](docs/backup-dr.md)
- [Runbooks](docs/runbooks.md)
- [Architecture decision records](docs/decisions/README.md)
- [OpenAPI contract](openapi/openapi.yaml)
- [Task tracker](todo.md)
- [Implementation roadmap](plans/2026-10-27-amrutam-telemedicine-backend-v1.md)
