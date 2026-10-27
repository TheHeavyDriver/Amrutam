# Amrutam Telemedicine Backend — Implementation Roadmap

## Objective

Deliver a production-grade, secure, and observable telemedicine backend that satisfies every deliverable in `description.md` and scores strongly against the published rubric (target: 90+/100 before bonus). The end state is a Git repository containing a running service, infrastructure as code, OpenAPI schema, architecture and threat-model documents, automated tests, a working CI/CD pipeline, and an observability stack that can be demonstrated end to end.

Success indicators:

- All seven deliverables are present, linked from the README, and reviewable without asking questions.
- The full booking-to-prescription journey works locally with one command and is covered by automated tests.
- p95 latency targets are demonstrated under load, not merely asserted.
- Idempotency, RBAC, audit logging, and encryption are treated as non-negotiable; the rubric explicitly fails submissions missing security or idempotency.

**Non-negotiables (never cut, even under time pressure):** idempotent writes, authorization on every route, audit trails for state changes, encryption and secret hygiene, and a reproducible test/CI path. These are the assignment's stated failure conditions.

## Recommended Stack and Key Decisions

| Concern | Choice | Rationale |
| --- | --- | --- |
| Language/runtime | TypeScript on Node.js 22 LTS | Fast delivery, strong typing, first-class OpenAPI and OpenTelemetry support; 100k consultations/day is ~1.2 req/s average, so Node is comfortably within the latency budget. |
| Framework | NestJS with the Fastify adapter | Native dependency injection, modular boundaries, guards and interceptors that map cleanly to RBAC and idempotency requirements; Fastify keeps overhead low. |
| Persistence | PostgreSQL 16 with Prisma plus hand-written SQL migrations | Relational integrity for clinical data; raw SQL migrations handle range partitions, exclusion constraints, and partial indexes that ORMs hide. |
| Cache/queue | Redis 7 with BullMQ | Cache-aside reads, distributed rate limits, and durable async jobs with retries and dead-letter queues from one dependency. |
| API style | REST with OpenAPI 3.1 | Simpler idempotency, caching, rate limiting, and latency control than GraphQL for this workflow-centric domain. |
| Auth | Argon2id passwords, short-lived JWT access tokens, rotating refresh tokens, TOTP MFA | Meets the MFA, encryption, and session-security requirements without outsourcing identity. |
| Observability | OpenTelemetry, Prometheus, Grafana, Loki, Tempo | One instrumentation path for traces, metrics, and logs; runs locally in Docker Compose and maps to managed services in production. |
| Local infra | Docker Compose | Reviewers can run the stack with a single command. |
| Production infra | Terraform plus Kubernetes manifests/Helm, GitHub Actions | Satisfies infrastructure-as-code and containerized CI/CD deliverables while keeping cloud-specific work time-boxed. |

**Deployment shape:** a modular monolith with clearly separated domain modules (identity, doctors, scheduling, consultations, prescriptions, payments, analytics, audit). This satisfies "modular services with DI" without paying the operational cost of microservices for an assignment-sized system. Boundaries are documented so modules could be extracted later.

## Delivery Timeline

Assumes one developer and roughly 10 working days. Compress or stretch phase boundaries to the real deadline; never reorder the security and idempotency work.

| Phase | Days | Focus | Exit criterion |
| --- | --- | --- | --- |
| 0. Foundations | 1 | Repository, stack, schema, API contract, design docs | Service boots, migrations run, OpenAPI validates |
| 1. Identity and audit | 2–3 | Auth, MFA, RBAC, audit trails | Authz matrix tests pass and every mutation is audited |
| 2. Clinical core | 4–6 | Availability, search, booking, consultations, prescriptions, payments | End-to-end booking journey passes with no double bookings |
| 3. Scale and reliability | 7–8 | Caching, load tests, observability, DR | p95 targets met under load and dashboards show the journey |
| 4. Delivery | 9–10 | Test hardening, CI/CD, IaC, documentation, rehearsal | Clean-clone pipeline is green and the demo runs start to finish |

**If only five days are available:** complete tasks 1, 2, 3, 5, 6, 7, 9, 16, and 18, and write the design documents for the deferred items. Breadth of documentation plus a working, secure booking flow scores better than a broad but shallow implementation.

## Implementation Plan

- [ ] 1. Scaffold the TypeScript modular monolith with linting, typed configuration, local Docker Compose infrastructure, and an ADR log.
  - Create the NestJS/Fastify application shell with strict TypeScript, ESLint, Prettier, and a consistent folder-per-module layout.
  - Add Docker Compose services for PostgreSQL 16, Redis 7, the OpenTelemetry collector, Prometheus, Grafana, Loki, and Tempo, plus a Makefile for common commands.
  - Add environment validation, structured logging with request IDs, graceful shutdown hooks, conventional commits, and architecture decision records.
  - Rationale: every later task depends on a reproducible local environment and consistent conventions.
  - Dependencies: none.
  - Key considerations: no secrets committed; one command must bring the stack up; keep the Compose file lean enough for reviewers.

- [ ] 2. Model the clinical domain in PostgreSQL migrations with constraints, indexes, range partitions, and deterministic seed data.
  - Create users, profiles, doctors, availability_slots, consultations, prescriptions, payments, audit_logs, idempotency_keys, and outbox_events.
  - Enforce invariants in the database: unique slot occupancy, valid state transitions, non-negative amounts, and foreign-key integrity.
  - Partition consultations and audit_logs by month, add partial and covering indexes for expected access paths, and use UUIDv7 identifiers.
  - Add a seed script with patients, doctors, availability, and historical consultations for demos and load tests.
  - Rationale: the rubric rewards data modeling and scalability, and database constraints are the last line of defense against double bookings.
  - Dependencies: task 1.
  - Key considerations: migrations must be reversible; partition maintenance must be automated; avoid premature sharding.

- [ ] 3. Publish the OpenAPI 3.1 contract and generated types as the single source of truth for the API.
  - Define auth, doctors, availability, bookings, consultations, prescriptions, payments, admin analytics, and health endpoints with a shared error envelope.
  - Standardize cursor pagination, filtering, the Idempotency-Key header, rate-limit headers, and correlation IDs.
  - Generate server types and a typed client, and add contract validation to CI.
  - Rationale: the schema is an explicit deliverable and prevents drift between implementation, tests, and documentation.
  - Dependencies: task 2 for field definitions.
  - Key considerations: document error codes and examples; keep breaking changes out of the first version.

- [ ] 4. Write the architecture package covering high-level design, data flow, booking sequence, ERD, retries, partitioning, caching, concurrency, sagas, and backup/DR.
  - Produce a 2–4 page architecture document with component and data-flow diagrams, plus a booking sequence diagram and an ERD generated from the schema.
  - Document retry and backoff policy, partition strategy, cache keys and invalidation, locking and concurrency approach, transactional boundaries, and saga compensation.
  - Document RPO/RTO, backup schedule, restore procedure, multi-AZ assumptions, and failure modes.
  - Rationale: Architecture is the highest-weighted rubric category and several sub-tasks exist only as written deliverables.
  - Dependencies: tasks 2 and 3 for accurate diagrams.
  - Key considerations: diagrams must match the implemented system; record trade-offs explicitly rather than only describing the happy path.

- [ ] 5. Implement identity, MFA, RBAC, and session security for patients, doctors, and administrators.
  - Add registration, login, email verification, Argon2id password hashing, short-lived access tokens, and rotating refresh tokens with reuse detection.
  - Enforce TOTP MFA for doctors and administrators, with recovery codes and step-up authentication for sensitive actions.
  - Build role and permission guards, ownership checks, account lockout, session revocation, and per-route rate limits.
  - Rationale: authentication and authorization are scored directly and gate every clinical endpoint.
  - Dependencies: tasks 1–3.
  - Key considerations: deny by default; never trust client-supplied roles; test the full role/resource matrix.

- [ ] 6. Add tamper-evident audit logging and PHI-safe structured logging across all state-changing operations.
  - Capture actor, action, resource, timestamp, request ID, source IP, and before/after hashes for every mutation.
  - Chain audit entries with a hash of the previous record to make tampering detectable, and document retention and access rules.
  - Add a redaction layer that strips tokens, passwords, and clinical free text from application logs.
  - Rationale: compliance and audit trails are explicit requirements, and PHI leakage in logs is a critical security failure.
  - Dependencies: tasks 2 and 5.
  - Key considerations: audit writes must not be silently dropped; verify the chain in a test; keep audit data immutable.

- [ ] 7. Build doctor profiles, recurring availability templates, exceptions, and concurrency-safe slot generation.
  - Support weekly schedules, timezone-aware slot generation, buffers, leave blocks, and one-off overrides.
  - Generate bookable slots deterministically and enforce database-level exclusivity so concurrent bookings cannot double-book.
  - Add doctor onboarding, credential metadata, verification status, and profile management endpoints.
  - Rationale: availability and booking are core flows worth 20 rubric points and the most likely place for race conditions.
  - Dependencies: tasks 2, 5, and 6.
  - Key considerations: store times in UTC with explicit timezone metadata; test daylight-saving transitions.

- [ ] 8. Implement doctor search and filtering with cursor pagination and cache-aside reads.
  - Support filters for specialty, language, fee range, rating, location, and next available slot, with deterministic sorting.
  - Add Redis cache-aside for search and profile reads with explicit TTLs and invalidation on profile or availability changes.
  - Enforce pagination limits and reject unbounded queries.
  - Rationale: search is a required workflow and the main read-latency path for the p95 target.
  - Dependencies: tasks 2 and 7.
  - Key considerations: cache keys must include every filter; measure cache hit rate; avoid stale availability after booking.

- [ ] 9. Implement idempotent booking with transactional slot reservation and a payment saga.
  - Require an Idempotency-Key on booking writes, persist request fingerprints and responses, and return the original result for replays.
  - Reserve the slot and create the consultation in one transaction, then run payment authorization and confirmation through an orchestrated saga with compensation on failure.
  - Handle cancellation, rescheduling, refunds, and expired holds with explicit policies and events.
  - Rationale: booking is the centerpiece flow, and missing idempotency is a stated automatic failure condition.
  - Dependencies: tasks 2, 7, and 8.
  - Key considerations: test duplicate and concurrent requests; lock ordering must prevent deadlocks; never charge without a confirmed slot.

- [ ] 10. Implement the consultation state machine, immutable prescriptions, and asynchronous document generation.
  - Enforce scheduled, in-progress, completed, cancelled, and no-show transitions with authorization at each step.
  - Issue short-lived consultation join tokens and record notes, diagnosis, and prescription line items.
  - Generate signed prescription documents asynchronously with versioning and an immutable audit trail.
  - Rationale: consultation lifecycle and prescriptions are explicitly required core workflows.
  - Dependencies: tasks 6, 7, and 9.
  - Key considerations: prescriptions must never be mutated after signing; generation failures must be retryable and visible.

- [ ] 11. Add outbox-backed asynchronous jobs with retries, exponential backoff, jitter, and dead-letter handling.
  - Publish domain events through a transactional outbox and dispatch them with BullMQ workers.
  - Configure bounded retries, backoff with jitter, idempotent consumers, and a dead-letter queue with replay tooling.
  - Schedule reminders, no-show detection, slot cleanup, payment reconciliation, and analytics rollups.
  - Rationale: reliability, retry strategy, and async processing are individually scored requirements.
  - Dependencies: tasks 2 and 9.
  - Key considerations: workers must be horizontally scalable; poison messages must not block the queue; expose DLQ depth as a metric.

- [ ] 12. Build role-gated admin analytics over aggregated read models.
  - Provide consultations per day, revenue, doctor utilization, cancellation and no-show rates, and top specialties with date-range filters.
  - Use materialized views or scheduled rollups with a documented freshness target instead of scanning transactional tables.
  - Cache responses briefly and enforce administrator-only access.
  - Rationale: admin analytics is a required workflow and demonstrates read-model thinking.
  - Dependencies: tasks 6, 9, 10, and 11.
  - Key considerations: analytics queries must not degrade booking latency; document acceptable staleness.

- [ ] 13. Harden query and runtime performance, then verify p95 targets with k6 load tests.
  - Analyze slow queries with EXPLAIN, add missing indexes, route reads to a replica, and introduce connection pooling.
  - Add response compression, request timeouts, payload limits, and query budgets.
  - Run scenario-based load tests at target and burst throughput with seeded data, and record read and write percentiles.
  - Rationale: latency and scale targets are explicit system requirements and scalability is worth 10 points.
  - Dependencies: tasks 2, 8, 9, and 12.
  - Key considerations: measure at realistic concurrency; report p95, p99, error rate, and saturation together.

- [ ] 14. Instrument traces, metrics, dashboards, alerts, and redacted logs end to end.
  - Add OpenTelemetry auto-instrumentation for HTTP, PostgreSQL, Redis, and queue workers with trace propagation across async boundaries.
  - Expose RED metrics plus business metrics such as booking success, payment failures, and DLQ depth.
  - Build Grafana dashboards for the booking journey and define alerts for error rate, latency, queue backlog, and failed bookings.
  - Add health and readiness endpoints with dependency checks.
  - Rationale: observability is worth 10 points and is a named deliverable.
  - Dependencies: tasks 1, 9, and 11.
  - Key considerations: verify a single trace spans HTTP, database, and queue work; test log redaction.

- [ ] 15. Implement backup, restore drills, RTO/RPO validation, and graceful degradation.
  - Configure automated snapshots plus point-in-time recovery, and document the retention policy.
  - Automate a restore drill that provisions a clean database and verifies row counts and checksums.
  - Add circuit breakers, retry budgets, dependency timeouts, and graceful shutdown for every external dependency.
  - Rationale: backup and DR strategy is an explicit architecture task and a reliability differentiator.
  - Dependencies: tasks 2 and 11.
  - Key considerations: an untested backup is not a backup; record measured restore time in the docs.

- [ ] 16. Build the automated test pyramid, including concurrency, idempotency, authorization, and contract coverage.
  - Add unit tests for domain rules, integration tests with Testcontainers for PostgreSQL and Redis, and end-to-end tests for the booking and consultation journeys.
  - Write adversarial tests for duplicate idempotency keys, concurrent slot booking, cross-role access, expired tokens, and invalid state transitions.
  - Enforce coverage gates on core modules and include failure-path tests for payments and queue retries.
  - Rationale: tests are a deliverable and directly support code quality, security, and core-flow scores.
  - Dependencies: tasks 5–14.
  - Key considerations: tests must be deterministic and runnable in CI; avoid mocking the database for concurrency tests.

- [ ] 17. Build CI/CD, infrastructure as code, container hardening, deployment, and rollback automation.
  - Create a multi-stage, non-root, minimal container image with health checks and pinned dependencies.
  - Run lint, typecheck, tests, migration checks, SAST, dependency and container scanning, SBOM generation, and secret scanning in GitHub Actions.
  - Provision managed PostgreSQL, Redis, networking, and secrets with Terraform, and deploy the service with Kubernetes manifests or Helm.
  - Add staging deployment, smoke tests, migration gating, and a tested rollback procedure.
  - Rationale: infra and CI are worth 10 points and are explicit deliverables.
  - Dependencies: tasks 1, 2, and 16.
  - Key considerations: pin action versions; never bake secrets into images; document required repository secrets.

- [ ] 18. Complete the README, runbooks, security package, demo script, and rubric self-review.
  - Document local setup, environment variables, migrations, seeding, test commands, architecture links, and API usage with examples.
  - Deliver the OWASP-mapped security checklist, STRIDE threat model, attack-surface analysis, data classification, encryption and key-rotation policy, and dependency-scanning evidence.
  - Add operational runbooks for deployment, rollback, restore, DLQ replay, and incident triage.
  - Rehearse the end-to-end demo from a clean clone, then score the submission against every rubric line and close gaps.
  - Rationale: presentation and documentation determine how the remaining work is judged, and the final review catches missing deliverables.
  - Dependencies: all prior tasks.
  - Key considerations: a reviewer should reach a working demo in under ten minutes; include a short architecture summary at the top of the README.

## Verification Criteria

- All seven deliverables from `description.md` are present in the repository and linked from the README.
- The OpenAPI 3.1 schema validates, covers every implemented route, and contract tests pass in CI.
- A new developer can clone the repository and run the full stack plus migrations and seeds in under ten minutes using documented commands.
- N concurrent requests with the same Idempotency-Key produce exactly one booking and one payment intent; the test is automated.
- Concurrent booking attempts against one slot produce exactly one success and zero double bookings under at least 200 parallel requests.
- Authorization matrix tests confirm that patients, doctors, and administrators cannot access each other's resources.
- MFA is enforced for doctor and administrator accounts, and session revocation and refresh-token reuse detection are tested.
- Every state-changing endpoint writes an audit record, and the hash-chain verification test passes.
- Log redaction tests confirm that tokens, passwords, and clinical free text never appear in logs.
- k6 load tests show p95 read latency below 200 ms and p95 write latency below 500 ms at the documented target concurrency, with an error rate below 1 percent.
- A single trace follows a booking through HTTP, PostgreSQL, Redis, and the queue worker in the observability stack.
- Grafana dashboards and alerts exist for latency, error rate, booking failures, queue depth, and DLQ depth.
- The restore drill completes within the documented RTO and preserves data integrity within the documented RPO.
- CI passes from a clean clone and includes lint, typecheck, tests, SAST, dependency and container scans, SBOM, and migration checks.
- Container images run as non-root and contain no embedded secrets.
- Core domain and service modules meet or exceed 80 percent line coverage, with all critical failure paths covered.
- The security package includes an OWASP Top 10 mapping, STRIDE threat model, data classification, encryption and key-rotation policy, and audit-log retention policy.
- The demo script runs the full journey from registration through booking, consultation, prescription, payment, and admin analytics without manual database intervention.
- Rubric self-review scores at least 90 of 100 before bonus items are counted.

## Potential Risks and Mitigations

1. **Over-scoping beyond the rubric**
   - Impact: core flows and documentation remain unfinished while effort goes into non-required features.
   - Likelihood: High.
   - Mitigation: Treat the rubric as the backlog; keep video, real payments, and notification providers behind adapters with sandbox implementations.
   - Contingency: Cut all bonus items first and protect idempotency, security, core flows, and tests.

2. **Double bookings and race conditions**
   - Impact: Direct loss of core-flow points and a credibility failure in the demo.
   - Likelihood: Medium.
   - Mitigation: Enforce database-level exclusivity, use a single transaction for reservation, and run a 200-request concurrency test in CI.
   - Contingency: Fall back to serializable isolation for the reservation transaction and document the throughput trade-off.

3. **Incomplete idempotency implementation**
   - Impact: Automatic failure per the rubric's stated conditions.
   - Likelihood: Medium.
   - Mitigation: Centralize idempotency in a reusable interceptor backed by a unique database constraint, and test duplicate and in-flight requests.
   - Contingency: Restrict the guarantee to the highest-risk write endpoints and document the scope explicitly rather than claiming full coverage.

4. **Infrastructure work consuming clinical-flow time**
   - Impact: A polished pipeline around an incomplete product.
   - Likelihood: Medium.
   - Mitigation: Time-box Terraform and Kubernetes work to one day; prioritize Compose, CI, and a single documented deployment path.
   - Contingency: Deliver Compose plus CI as the working deployment and Terraform as reviewed, plan-only infrastructure code.

5. **PHI leakage or missing authorization**
   - Impact: Critical security failure and possible disqualification.
   - Likelihood: Low to Medium.
   - Mitigation: Deny-by-default guards, response serializers that expose only approved fields, log redaction, and automated authz and redaction tests.
   - Contingency: Add a final security review task and manually exercise every route with each role before submission.

6. **Observability added too late**
   - Impact: Missing traces and dashboards at demo time, losing observability points.
   - Likelihood: Medium.
   - Mitigation: Instrument in phases alongside each module, starting with auto-instrumentation in the scaffold.
   - Contingency: Keep a prebuilt dashboard and alert set that can be wired to the collector at the end.

7. **Partitioning and migration complexity**
   - Impact: Broken migrations or slow queries under seeded load.
   - Likelihood: Medium.
   - Mitigation: Partition only consultations and audit_logs by month, automate partition creation, and test migrations up and down against seeded data.
   - Contingency: Keep the schema partition-ready with a documented manual maintenance runbook instead of full automation.

8. **Analytics queries degrading transactional latency**
   - Impact: Booking p95 regressions and unstable load-test results.
   - Likelihood: Medium.
   - Mitigation: Use rollups or materialized views, a read replica, short cache TTLs, and statement timeouts for analytics queries.
   - Contingency: Precompute analytics on a schedule and serve stale data with an explicit freshness indicator.

## Alternative Approaches

1. **Go with chi, sqlc, and pgx**
   - Description: A compiled, low-overhead service with explicit SQL and strong concurrency primitives.
   - Pros: Excellent latency and resource efficiency, straightforward profiling, strong fit for high-throughput booking.
   - Cons: More boilerplate for DI, OpenAPI generation, and validation; slower iteration for a time-boxed assignment.
   - Recommendation: Not chosen for the primary path because TypeScript/NestJS maps directly to the DI and modularity requirements. Revisit if raw throughput becomes the binding constraint.

2. **GraphQL instead of REST**
   - Description: A single typed graph with resolvers and persisted queries.
   - Pros: Flexible client data fetching and a strong schema story.
   - Cons: Harder idempotency, HTTP caching, rate limiting, and per-query latency guarantees; more authorization surface area.
   - Recommendation: Not chosen; REST with OpenAPI better matches the latency, caching, and idempotency requirements.

3. **Microservices per domain**
   - Description: Separate identity, scheduling, consultation, payment, and analytics services.
   - Pros: Independent scaling and clear ownership boundaries in a real organization.
   - Cons: Distributed transactions, operational overhead, and slower delivery; unnecessary at the stated average throughput.
   - Recommendation: Not chosen; a modular monolith with enforced module boundaries and an outbox provides the same design evidence at a fraction of the cost.

4. **Managed identity provider such as Keycloak**
   - Description: Delegate registration, login, MFA, and token issuance to an external identity server.
   - Pros: Mature security features and less custom auth code.
   - Cons: Extra infrastructure and configuration; less visible evidence of security engineering for the rubric.
   - Recommendation: Not chosen; custom auth with Argon2id, rotating refresh tokens, and TOTP demonstrates the required competencies directly.

## Assumptions

- The assignment is a greenfield build with no existing code; the repository currently contains only `description.md`.
- One developer executes the roadmap over roughly ten working days, with Docker and Node.js available locally.
- The 100k daily consultations figure is an average design target; capacity planning assumes a 5–10x burst and documents the resulting headroom.
- Payments and video consultations are provider-agnostic adapters with sandbox or mock implementations; no real money or PHI is processed.
- Analytics freshness of up to five minutes is acceptable, enabling rollups and caching.
- Production infrastructure is documented and provisioned as code but need not run continuously; local Compose is the primary demo environment.
- A single region with multi-AZ database deployment satisfies the 99.95 percent availability target at this stage.

## Dependencies

- Node.js 22 LTS, npm, Docker, and Docker Compose for local development and testing.
- PostgreSQL 16 and Redis 7 images, plus Testcontainers support for integration tests.
- A GitHub repository with Actions enabled and permission to configure required secrets.
- Optional cloud credentials for Terraform apply and a Kubernetes cluster; plan-only validation is acceptable if unavailable.
- k6 for load testing and a machine capable of sustaining the target request rate.
- OpenTelemetry collector, Prometheus, Grafana, Loki, and Tempo images for the observability stack.

## Rubric Traceability

| Rubric area | Points | Primary evidence | Tasks |
| --- | --- | --- | --- |
| Architecture | 20 | Architecture doc, ERD, booking sequence, partitioning, caching, saga, retry, backup/DR | 2, 4, 7, 9, 11, 15 |
| Core Flows | 20 | Auth, availability, booking, consultation, prescriptions, payments, search, analytics | 5, 7, 8, 9, 10, 12 |
| Code Quality | 15 | Modular layout, DI, strict typing, linting, tests, consistent conventions | 1, 16 |
| Security | 10 | MFA, RBAC, encryption, audit chain, threat model, OWASP checklist, scanning | 5, 6, 17, 18 |
| Observability | 10 | Traces, RED and business metrics, dashboards, alerts, redacted logs | 14 |
| Scalability | 10 | Partitions, indexes, read replicas, pooling, caching, load-test evidence | 2, 8, 11, 13, 15 |
| Infra/CI | 10 | Docker, Terraform, Kubernetes, GitHub Actions, scans, rollback | 1, 17 |
| Bonus | +10 | Idempotency and concurrency suites, DR drill, SBOM, runbooks, polished demo | 6, 11, 15, 16, 17, 18 |

## Notes

- Treat the seven deliverables as the definition of done; a feature that is not documented and linked from the README is effectively invisible to a reviewer.
- Keep a running `docs/decisions/` log from day one. Retrospective architecture documents are usually vague and score poorly.
- Demo the failure paths, not only the happy path: duplicate booking, unauthorized access, payment failure compensation, and DLQ replay.
- Record actual measurements (latency percentiles, restore time, coverage) in the documentation instead of making qualitative claims.
- Reserve the final half-day for a clean-clone rehearsal; this consistently catches missing environment variables, migrations, and seed steps.
- Commit early and often with conventional messages so the repository history demonstrates incremental delivery.
