# Amrutam Telemedicine Backend — status

Source of truth for scope: [`description.md`](description.md). Architecture decisions and the original delivery plan remain in [`plans/`](plans/) and [`docs/decisions/`](docs/decisions/).

**Legend:** `[x]` implemented and locally verified · `[~]` implemented but needs an external environment/drill · `[ ]` not done / production follow-up

## Non-negotiables

- [x] **Idempotent writes** — transactional `idempotency_keys`, actor/key advisory lock, request fingerprint, stored response replay, `Idempotency-Replayed: true`, and `422 IDEMPOTENCY_KEY_REUSED`; booking and payment e2e tests cover duplicate/concurrent requests.
- [x] **Authorization on every route** — deny-by-default global JWT guard + roles guard, explicit `@Public()` allowlist, service-level ownership/state checks, and cross-role e2e tests.
- [x] **Audit trails for state changes** — append-only hash-chained `audit_logs`, serialised with an advisory transaction lock; audit, clinical state, and outbox commit in one transaction. Admin search/verification endpoints included.
- [x] **Encryption and secret hygiene** — Argon2id, AES-256-GCM for TOTP secrets/tokens, HMAC refresh tokens and capability URLs, required startup secrets, redacted logs, KMS/Secrets Manager Terraform, ExternalSecret example, no committed `.env`.
- [x] **Reproducible tests/CI path** — deterministic test reset/seed, 18 suites / 111 tests, `npm test`, GitHub Actions quality/integration/supply-chain/CodeQL jobs, Docker build, SBOM, and gated staging CD workflow.

## Assignment deliverables

- [x] **1. Git repo with code and infra** — API, worker, SQL migrations, tests, Terraform, Kubernetes, observability, docs.
- [x] **2. README with setup** — [`README.md`](README.md): quick start, configuration, API examples, demo, tests, observability, deployment, limitations.
- [x] **3. OpenAPI/GraphQL schema** — [`openapi/openapi.yaml`](openapi/openapi.yaml), 56 operations, Redocly-validated, generated typed client, contract e2e test.
- [x] **4. Architecture doc (2–4 pages)** — [`docs/architecture.md`](docs/architecture.md): components, request path, ERD, booking sequence, saga, retries, partitioning, caching, failure modes, observability, trade-offs.
- [x] **5. Tests and CI pipeline** — [`test/`](test), [`.github/workflows/ci.yml`](.github/workflows/ci.yml), [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml), [`.github/workflows/cd-staging.yml`](.github/workflows/cd-staging.yml).
- [x] **6. Observability setup** — Prometheus metrics, Grafana dashboard, alert rules, OTel traces, Loki logs, health/readiness, runbooks.
- [x] **7. Security checklist and threat model** — [`docs/security.md`](docs/security.md): OWASP mapping, STRIDE, attack surface, data classification, authz matrix, encryption/key rotation, retention, release checklist, residual risks.

## Core workflows

- [x] **User lifecycle** — registration, login, email verification token flow, password reset, profile, password change, roles, sessions, refresh rotation/reuse detection, lockout, TOTP MFA, recovery codes, admin session revocation.
- [x] **Doctor availability and booking** — public doctor search/detail/availability, doctor-managed one-off availability slots, slot generation/seed, row-locked booking, patient-overlap lock, unique slot claim, GiST exclusion constraint, idempotent create/reschedule/cancel, join token, start/complete/no-show.
- [x] **Consultation lifecycle and prescriptions** — scheduled → in-progress → completed/cancelled/no-show, doctor assignment checks, draft/update/sign/void prescriptions, immutable signed HTML + SHA-256, short-lived HMAC capability URL.
- [x] **Search and filtering** — specialty, language, fee range, rating, location, next availability; deterministic sorting and cursor pagination; cache keys include all filters.
- [x] **Compliance and audit** — hash-chained audit for auth/admin/clinical/payment state changes; PHI-free metadata; admin search/verify; monthly partitions; idempotency and audit retention cleanup.
- [x] **Payments and refunds** — server-derived fees, one active payment per consultation, idempotent intent/confirm, HMAC webhook verification and event dedupe, partial/full refunds, append-only refund ledger, async cancellation compensation/reconciliation.
- [x] **Admin analytics** — consultations/day, revenue, refunds/net, doctor utilization, cancellation/no-show rates, top specialties, UTC buckets, 366-day cap, admin-only.
- [x] **Async work** — PostgreSQL transactional outbox, `FOR UPDATE SKIP LOCKED`, bounded retries, exponential backoff + jitter, stale-lock recovery, dead-letter status, CLI replay, scheduled reminders/no-show/refund/partition/cleanup jobs with advisory locks.

## Verification evidence (local)

| Check                                         | Result                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run format:check`                        | Pass                                                                                                                                 |
| `npm run typecheck`                           | Pass                                                                                                                                 |
| `npm run lint`                                | Pass                                                                                                                                 |
| `npm run build`                               | Pass                                                                                                                                 |
| `npm run api:check`                           | OpenAPI valid + generated client typechecks                                                                                          |
| `TEST_DATABASE_URL=… npm test`                | 18 suites / 111 tests pass                                                                                                           |
| `docker compose config`                       | Pass                                                                                                                                 |
| `docker build -t amrutam-api:local .`         | Pass; runtime runs as UID 1000 with npm/npx/yarn removed                                                                             |
| Trivy image scan (HIGH/CRITICAL, fixed only)  | Pass; 0 findings after removing the npm/yarn bundled dependency trees                                                                |
| Gitleaks secret scan                          | Pass; no leaks with test fixtures allowlisted                                                                                        |
| `npm audit --omit=dev --audit-level=high`     | 0 vulnerabilities                                                                                                                    |
| Worker smoke test (`node dist/worker.js`)     | `/health/live` 200, `/metrics` exposes outbox/process metrics, graceful SIGTERM                                                      |
| `scripts/demo.sh`                             | Login → search → availability → booking → payment capture → cancellation passed; worker produced refund ledger                       |
| Restore drill                                 | Local PostgreSQL 16 dump/restore + integrity SQL passed (0 active consultations without claim, 0 over-refunds, 0 broken audit links) |
| `terraform fmt -check` / `terraform validate` | Pass (provider init without backend)                                                                                                 |
| `kustomize build` staging/prod                | Pass (16 rendered objects)                                                                                                           |
| `scripts/verify-restore.sql`                  | Pass against test database                                                                                                           |
| k6 load test                                  | Not executed against a provisioned environment; thresholds/results remain unmeasured                                                 |
| Terraform plan/apply                          | Not executed (no AWS credentials/account in this environment)                                                                        |
| Kubernetes apply / staging CD                 | Not executed against a live cluster; manifests render and workflow is gated by environment secrets                                   |
| GitHub Actions                                | Workflow authored but not executed on GitHub from this environment                                                                   |

## Production follow-ups (not assignment blockers)

- [ ] Endpoint-specific distributed rate limits and step-up authentication for high-risk admin actions.
- [ ] Real email/SMS/push provider behind the notification adapter; delivery evidence and bounce handling.
- [ ] Real payment provider adapter (idempotent authorise/capture/refund, webhook secret rotation, reconciliation dashboard).
- [ ] External WORM anchoring of audit-chain heads; field-level encryption for free-text clinical notes if policy requires it.
- [ ] Recurring weekly availability templates, timezone-aware schedule editing, buffers, and leave blocks; current doctor-managed slots are one-off.
- [ ] Read replicas/PgBouncer routing and materialised analytics rollups when volume exceeds indexed-query capacity.
- [ ] Producer-to-worker trace-context propagation across the outbox boundary (worker spans currently correlate by event ID).
- [ ] Execute k6 at target/burst load, record p95/p99/saturation, and size RDS/ElastiCache from the result.
- [ ] Run a restore drill against a real RDS snapshot/PITR copy and record measured RTO/RPO.
- [ ] Independent penetration test and clinical/compliance review before handling real PHI.
