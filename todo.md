# Amrutam Telemedicine Backend — TODO

Working checklist derived from `plans/2026-10-27-amrutam-telemedicine-backend-v1.md`.
Source of truth for scope: `description.md`.

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

**Non-negotiables (assignment auto-fail if missing):** idempotent writes, authz on every route, audit trails for state changes, encryption + secret hygiene, reproducible test/CI path.

---

## Phase 0 — Foundations (Day 1)

- [x] **1. Scaffold the modular monolith**
  - [x] NestJS + Fastify shell, strict TypeScript, ESLint, Prettier
  - [x] Consistent folder-per-module layout (domain modules land as each phase progresses)
  - [x] Docker Compose: PostgreSQL 16, Redis 7, OTel collector, Prometheus, Grafana, Loki, Tempo
  - [x] Makefile for common commands
  - [x] Typed env validation, structured logging with request IDs, graceful shutdown
  - [x] Conventional commits + `docs/decisions/` ADR log
  - [x] Verify: one command brings the stack up; no secrets committed

- [ ] **2. Clinical data model in PostgreSQL**
  - [ ] Tables: `users`, `profiles`, `doctors`, `availability_slots`, `consultations`, `prescriptions`, `payments`, `audit_logs`, `idempotency_keys`, `outbox_events`
  - [ ] DB invariants: unique slot occupancy, valid state transitions, non-negative amounts, FK integrity
  - [ ] Monthly range partitions for `consultations` and `audit_logs`
  - [ ] Partial/covering indexes for expected access paths; UUIDv7 identifiers
  - [ ] Reversible migrations; automated partition maintenance
  - [ ] Deterministic seed: patients, doctors, availability, historical consultations
  - [ ] Verify: migrations up/down pass against seeded data

- [ ] **3. OpenAPI 3.1 contract**
  - [ ] Endpoints: auth, doctors, availability, bookings, consultations, prescriptions, payments, admin analytics, health
  - [ ] Shared error envelope; cursor pagination; filter conventions
  - [ ] `Idempotency-Key` header, rate-limit headers, correlation IDs documented
  - [ ] Generate server types + typed client
  - [ ] Contract validation wired into CI

- [ ] **4. Architecture package (2–4 pages)**
  - [ ] High-level components + data-flow diagrams
  - [ ] Booking flow sequence diagram
  - [ ] ERD generated from schema
  - [ ] Retry/backoff policy, partition strategy, cache keys + invalidation
  - [ ] Concurrency/locking approach, transaction boundaries, saga compensation
  - [ ] RPO/RTO, backup schedule, restore procedure, multi-AZ assumptions, failure modes
  - [ ] Verify: diagrams match the implemented system; trade-offs recorded

---

## Phase 1 — Identity and Audit (Days 2–3)

- [ ] **5. Identity, MFA, RBAC, sessions**
  - [ ] Registration, login, email verification
  - [ ] Argon2id hashing; short-lived access tokens; rotating refresh tokens with reuse detection
  - [ ] TOTP MFA for doctors/admins; recovery codes; step-up auth for sensitive actions
  - [ ] Role/permission guards, ownership checks, account lockout, session revocation
  - [ ] Per-route rate limits
  - [ ] Verify: full role/resource authorization matrix tests pass; deny by default

- [ ] **6. Tamper-evident audit + PHI-safe logging**
  - [ ] Capture actor, action, resource, timestamp, request ID, source IP, before/after hashes
  - [ ] Hash-chain audit entries; retention + access rules documented
  - [ ] Redaction layer strips tokens, passwords, clinical free text from logs
  - [ ] Verify: every mutation writes an audit record; chain verification test passes; no PHI in logs

---

## Phase 2 — Clinical Core (Days 4–6)

- [ ] **7. Doctor profiles + availability**
  - [ ] Weekly recurring schedules, timezone-aware, buffers, leave blocks, one-off overrides
  - [ ] Deterministic slot generation + DB-level exclusivity (no double booking)
  - [ ] Doctor onboarding, credential metadata, verification status, profile endpoints
  - [ ] Verify: daylight-saving transition tests pass; UTC storage with explicit timezone metadata

- [ ] **8. Doctor search + caching**
  - [ ] Filters: specialty, language, fee range, rating, location, next available slot
  - [ ] Deterministic sorting; cursor pagination with enforced limits
  - [ ] Redis cache-aside with explicit TTLs + invalidation on profile/availability change
  - [ ] Verify: cache keys include every filter; hit rate measured; no stale availability after booking

- [ ] **9. Idempotent booking + payment saga** ⚠️ auto-fail if missing
  - [ ] `Idempotency-Key` required; persist request fingerprints + responses; replay returns original result
  - [ ] Reserve slot + create consultation in one transaction
  - [ ] Payment authorization/confirmation via orchestrated saga with compensation
  - [ ] Cancellation, rescheduling, refunds, expired holds with explicit policies + events
  - [ ] Verify: duplicate/concurrent replay tests; 200 parallel attempts on one slot → exactly one success

- [ ] **10. Consultation lifecycle + prescriptions**
  - [ ] State machine: scheduled → in-progress → completed / cancelled / no-show, authz at each step
  - [ ] Short-lived consultation join tokens; notes, diagnosis, prescription line items
  - [ ] Async signed prescription documents with versioning + immutable audit trail
  - [ ] Verify: prescriptions immutable after signing; generation failures retryable and visible

- [ ] **11. Outbox-backed async jobs**
  - [ ] Transactional outbox → BullMQ workers
  - [ ] Bounded retries, exponential backoff + jitter, idempotent consumers
  - [ ] DLQ with replay tooling
  - [ ] Scheduled jobs: reminders, no-show detection, slot cleanup, payment reconciliation, analytics rollups
  - [ ] Verify: poison messages don't block queue; DLQ depth exposed as metric; workers scale horizontally

- [ ] **12. Admin analytics**
  - [ ] Consultations/day, revenue, doctor utilization, cancellation/no-show rates, top specialties
  - [ ] Date-range filters; materialized views or scheduled rollups
  - [ ] Documented freshness target; short cache; admin-only access
  - [ ] Verify: analytics queries don't degrade booking latency

---

## Phase 3 — Scale, Observability, Reliability (Days 7–8)

- [ ] **13. Performance hardening + load tests**
  - [ ] EXPLAIN slow queries; add missing indexes; read replica; connection pooling
  - [ ] Response compression, request timeouts, payload limits, query budgets
  - [ ] k6 scenario tests at target + burst throughput on seeded data
  - [ ] Verify: p95 reads <200 ms, p95 writes <500 ms, error rate <1%; report p95/p99 + saturation

- [ ] **14. Observability end to end**
  - [ ] OTel auto-instrumentation: HTTP, PostgreSQL, Redis, queue workers; trace propagation across async boundaries
  - [ ] RED metrics + business metrics (booking success, payment failures, DLQ depth)
  - [ ] Grafana dashboards for booking journey; alerts for error rate, latency, queue backlog, failed bookings
  - [ ] Health + readiness endpoints with dependency checks
  - [ ] Verify: one trace spans HTTP → Postgres → Redis → worker; log redaction tested

- [ ] **15. Backup, DR, graceful degradation**
  - [ ] Automated snapshots + PITR; retention policy documented
  - [ ] Automated restore drill: clean DB, verify row counts + checksums
  - [ ] Circuit breakers, retry budgets, dependency timeouts, graceful shutdown
  - [ ] Verify: measured restore time within documented RTO/RPO

---

## Phase 4 — Delivery (Days 9–10)

- [ ] **16. Test pyramid**
  - [ ] Unit tests for domain rules
  - [ ] Integration tests with Testcontainers (PostgreSQL, Redis)
  - [ ] E2E tests for booking + consultation journeys
  - [ ] Adversarial: duplicate idempotency keys, concurrent booking, cross-role access, expired tokens, invalid state transitions
  - [ ] Failure-path tests: payments, queue retries
  - [ ] Verify: deterministic in CI; ≥80% line coverage on core modules

- [ ] **17. CI/CD + IaC + container hardening**
  - [ ] Multi-stage, non-root, minimal image; health checks; pinned dependencies
  - [ ] GitHub Actions: lint, typecheck, tests, migration checks, SAST, dependency + container scans, SBOM, secret scanning
  - [ ] Terraform: managed PostgreSQL, Redis, networking, secrets
  - [ ] Kubernetes manifests/Helm; staging deploy, smoke tests, migration gating, tested rollback
  - [ ] Verify: clean-clone pipeline green; no secrets in images; required repo secrets documented

- [ ] **18. Documentation, security package, demo, self-review**
  - [ ] README: setup, env vars, migrations, seeding, tests, architecture links, API examples
  - [ ] OWASP Top 10 mapping, STRIDE threat model, attack-surface analysis
  - [ ] Data classification, encryption + key-rotation policy, audit-log retention policy
  - [ ] Dependency-scanning evidence
  - [ ] Runbooks: deploy, rollback, restore, DLQ replay, incident triage
  - [ ] Demo script: registration → booking → consultation → prescription → payment → analytics
  - [ ] Clean-clone rehearsal (<10 min to working demo)
  - [ ] Rubric self-review ≥90/100

---

## Definition of Done (deliverable checklist)

- [ ] Git repo with code and infra
- [ ] README with setup
- [ ] OpenAPI/GraphQL schema
- [ ] Architecture doc (2–4 pages)
- [ ] Tests and CI pipeline
- [ ] Observability setup
- [ ] Security checklist and threat model

## Verification Gates (from the plan)

- [ ] All 7 deliverables present and linked from README
- [ ] OpenAPI validates, covers every route, contract tests green
- [ ] Clean clone → full stack + migrations + seeds in <10 min
- [ ] N requests with same `Idempotency-Key` → exactly one booking + one payment intent
- [ ] 200 parallel attempts on one slot → one success, zero double bookings
- [ ] Authz matrix: no cross-role resource access
- [ ] MFA enforced for doctors/admins; revocation + refresh reuse detection tested
- [ ] Every state change audited; hash-chain verification passes
- [ ] Log redaction tests pass (no tokens/passwords/clinical text)
- [ ] k6: p95 read <200 ms, p95 write <500 ms, error rate <1%
- [ ] Single trace spans HTTP → Postgres → Redis → worker
- [ ] Dashboards + alerts for latency, errors, booking failures, queue/DLQ depth
- [ ] Restore drill within RTO/RPO with integrity verified
- [ ] CI green from clean clone with all scans + SBOM
- [ ] Image runs non-root, no embedded secrets
- [ ] Core modules ≥80% coverage, critical failure paths covered
- [ ] Security package complete (OWASP, STRIDE, classification, encryption/key rotation, retention)
- [ ] Demo runs journey end to end without manual DB intervention
- [ ] Self-review scores ≥90/100 before bonus

## Risks to Watch

- [ ] Scope creep beyond rubric → cut bonus first, protect idempotency/security/core flows/tests
- [ ] Double bookings → DB exclusivity + single-transaction reservation + concurrency test in CI
- [ ] Incomplete idempotency → one reusable interceptor + unique DB constraint
- [ ] Infra eating clinical time → time-box to 1 day; Compose + CI is the working deployment
- [ ] PHI leakage / missing authz → deny-by-default, response serializers, redaction, final route-by-route role review
- [ ] Observability added late → instrument per module from scaffold
- [ ] Partition/migration complexity → partition only `consultations` + `audit_logs`; test up/down
- [ ] Analytics degrading booking latency → rollups/MVs, replica, short TTLs, statement timeouts
