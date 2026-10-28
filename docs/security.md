# Security, privacy, and threat model

This document is the security package for the assignment: OWASP Top 10 mapping, STRIDE threat model, attack surface, authorization matrix, data classification, encryption/key rotation, audit retention, and a release checklist. It reflects the implemented code, with residual risks called out explicitly.

## 1. Assets and data classification

| Class                      | Examples                                                                                                                                                 | Handling                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Highly sensitive / PHI** | Consultation reason, notes, diagnoses, prescription items, rendered prescription documents, signed document capability URLs, payment provider references | PostgreSQL encrypted at rest; TLS in transit; never cached; never placed in audit metadata or logs; access is owner/role constrained |
| **Sensitive / PII**        | Email, phone, date of birth, address, TOTP secrets, refresh/verification/reset token hashes, IP address, user agent                                      | Encrypted at rest; token values are hashed or AES-256-GCM encrypted; redacted from logs; audit stores hashes/metadata only           |
| **Sensitive / financial**  | Payment amounts, statuses, refund ledger, provider event IDs                                                                                             | Integer minor units; server-derived amounts; append-only refund ledger; audit and outbox in the same transaction                     |
| **Internal**               | Audit hash chain, idempotency records, outbox payloads, metrics                                                                                          | Access restricted; no unrestricted public export                                                                                     |
| **Public**                 | Verified doctor listing, availability, health status                                                                                                     | Cacheable; must exclude email, license documents, and private profile fields                                                         |

Retention: clinical and payment records follow the legal/regulatory retention policy of the operator (typically 7+ years for healthcare/financial records). Audit logs are append-only and retained for at least one year online with longer archive retention. Idempotency records expire after 24 hours by default. Auth tokens expire by policy; expired idempotency keys are cleaned by a scheduler. Session and refresh-token records are revocable and retained only as long as needed for reuse detection/security investigation.

## 2. STRIDE threat model

### Trust boundaries

1. Internet → ingress/load balancer.
2. Ingress → API (JWT, TLS).
3. API → PostgreSQL/Redis (TLS, private network, credentials from secrets).
4. Payment provider → public webhook (raw-body HMAC capability).
5. Patient/doctor browser → signed prescription capability URL.
6. Worker → database/outbox (same network and credentials boundary as API).
7. Monitoring/operators → metrics, Grafana, logs.

### Threats and controls

| STRIDE                            | Threat                                                                                     | Controls                                                                                                                                                                                                  | Residual risk / action                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Spoofing**                      | Credential stuffing, stolen password, forged JWT                                           | Argon2id, lockout after 5 failures, short-lived JWT (15 min), separate MFA JWT secret, rotating refresh tokens with reuse detection, TOTP for doctors/admins, session revocation, generic login errors    | Add endpoint-specific rate limits with a distributed store and device/risk signals; pen-test |
| **Spoofing**                      | Forged payment webhook                                                                     | Public webhook route verifies HMAC-SHA256 over the raw body with a required secret; constant-time comparison; provider event dedupe; state-transition checks                                              | Secret rotation runbook and provider IP allowlist/WAF recommended                            |
| **Tampering**                     | Client changes fee, patient/doctor ID, role, or ownership                                  | Fee is derived server-side; IDs come from path/body but services verify ownership and role; Zod strict validation; parameterised SQL; no ORM mass assignment                                              | Keep route/role matrix current in review                                                     |
| **Tampering**                     | Double booking or lost update                                                              | Row locks, patient advisory lock, unique slot claim, GiST exclusion constraint, single transaction, idempotency advisory lock, optimistic status predicates                                               | Load test concurrency at peak                                                                |
| **Repudiation**                   | User denies a clinical/admin action                                                        | Hash-chained append-only audit with actor, role, action, resource, request ID, IP/UA, before/after hashes and metadata; audit and state commit atomically; admin chain verification                       | Chain head anchor to external WORM storage is an operational enhancement                     |
| **Information disclosure**        | PHI in logs, cache, URLs, or error messages                                                | PHI-free audit metadata and logs; pino redaction; cache excludes PHI; signed capability URLs expire (default 300 s) and contain an HMAC token; error envelope hides internals; no stack traces to clients | Add automated log-redaction assertions in CI; configure log retention                        |
| **Information disclosure**        | Prescription document link leakage                                                         | HMAC capability token bound to document + expiry, constant-time comparison, `Cache-Control: no-store`, content-disposition attachment                                                                     | Consider one-time download tokens/watermark for stricter policy                              |
| **Denial of service**             | Request floods, expensive searches, connection exhaustion                                  | Global rate limit, 1 MiB body limit, pagination caps, bounded date ranges (366 days), SQL statement timeouts, pool limits, compression, HPA                                                               | Add WAF/L7 DDoS protection and endpoint-specific limits in production                        |
| **Elevation of privilege**        | Patient calls admin route, doctor edits another doctor, user accesses another consultation | Global deny-by-default JWT guard + roles guard; `@Public` allowlist; service ownership checks; admin verification transitions; session revocation on suspension                                           | Add automated route-permission matrix tests (currently covered per module)                   |
| **Elevation of privilege**        | Refresh token replay or token theft                                                        | Opaque random refresh tokens stored HMAC-hashed; rotation on every refresh; reuse detection revokes the session family; server-side revocation; separate MFA token type                                   | Bind refresh tokens to device fingerprint in a future iteration                              |
| **Supply chain**                  | Malicious dependency, vulnerable base image, leaked secret                                 | `npm ci` from lockfile, pinned exact direct deps, Dependabot, `npm audit`, Trivy image/fs scan, SBOM, gitleaks scan, non-root minimal runtime image with package managers removed, no secrets in layers   | Enable signed images/SLSA provenance when registry supports it                               |
| **Repudiation / Tampering (ops)** | Operator replays DLQ event to alter payment state                                          | Replay only requeues; handlers are idempotent and append audit records; DLQ CLI does not modify payment rows directly; access to worker/DB is privileged                                                  | Use break-glass approval and audit cloud console access                                      |

### Attack surface

- Public HTTP: health/liveness/readiness, metrics (network-restricted), auth register/login/refresh/verify/reset/MFA challenge, doctor search/detail/availability, payment webhooks.
- Authenticated HTTP: profile, doctor availability management, booking/consultation lifecycle, prescriptions, payments, admin verification/analytics/audit.
- Capability URL: prescription document content.
- Internal: PostgreSQL, Redis, OTLP collector, worker metrics, Grafana, Prometheus, Loki, Tempo. These are private-network services in Kubernetes/Compose; no public ingress.

## 3. OWASP Top 10 mapping

| OWASP 2021                                 | Implementation                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 Broken access control                  | Deny-by-default guards; `@Public` limited and reviewed; service-level ownership; admin-only analytics/audit; no client-controlled roles; tests for cross-role access                            |
| A02 Cryptographic failures                 | TLS for transit; AES-256-GCM for TOTP secrets/auth tokens; Argon2id passwords; HMAC refresh tokens/token pepper; hashed audit chain; secrets never hard-coded; KMS-encrypted data stores in IaC |
| A03 Injection                              | Parameterised SQL everywhere; strict Zod schemas; no string-built SQL from user input; HTML prescription rendering uses escaped structured data                                                 |
| A04 Insecure design                        | Explicit state machines, database invariants, idempotency, audit/outbox atomicity, saga compensation, bounded retries                                                                           |
| A05 Security misconfiguration              | Helmet, CORS allowlist, body limit, non-root container, no stack traces, env validation fail-fast, read-only root filesystem in K8s                                                             |
| A06 Vulnerable/outdated components         | Lockfile, exact direct versions, Dependabot, npm audit, Trivy, CodeQL                                                                                                                           |
| A07 Identification/authentication failures | MFA for privileged roles, lockout, short access tokens, refresh rotation/reuse detection, generic errors, session revocation, recovery codes                                                    |
| A08 Software/data integrity failures       | Migration checksums and advisory locks, audit hash chain, provider webhook HMAC + event dedupe, immutable signed documents, immutable image build workflow (image signing is recommended)       |
| A09 Logging/monitoring failures            | Structured logs, request IDs, RED/business metrics, traces, alerts, audit search/verification, DLQ metrics                                                                                      |
| A10 SSRF                                   | No user-controlled outbound fetch. Payment provider calls are adapter-controlled; document URLs are generated from internal IDs                                                                 |

## 4. Authorization matrix

| Resource/action                         | Patient            | Doctor                     | Admin                    |
| --------------------------------------- | ------------------ | -------------------------- | ------------------------ |
| Own profile / password                  | read/write         | read/write                 | read/write               |
| Doctor discovery/availability           | public             | public                     | public                   |
| Manage own availability                 | no                 | own (available slots only) | no                       |
| Create booking                          | yes (own)          | no                         | no                       |
| View consultation                       | own                | assigned                   | any                      |
| Cancel/reschedule                       | own                | no                         | any                      |
| Start/complete/no-show                  | no                 | assigned                   | no (use admin workflows) |
| Prescription draft/sign/void            | no                 | assigned                   | no                       |
| Download signed prescription            | own                | assigned                   | any                      |
| Create/confirm payment                  | own                | no                         | no                       |
| Refund payment                          | no                 | no                         | yes                      |
| Payment webhook                         | provider HMAC only | provider HMAC only         | provider HMAC only       |
| Doctor verification                     | no                 | no                         | yes                      |
| Analytics / audit search / chain verify | no                 | no                         | yes                      |

**Note:** `no-show` is doctor/admin in the controller/service; the admin column should be read as “yes” for that route. Prescription signing is doctor-only. The route-level tests in `test/` cover these paths and unauthorized attempts.

## 5. Encryption and key management

| Secret                       | Generation                                            | Storage                          | Rotation                                                                                                             |
| ---------------------------- | ----------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`          | 48+ random bytes / hex                                | Secrets Manager → K8s Secret/env | Rotate with a dual-key verify window; invalidate sessions                                                            |
| `JWT_MFA_SECRET`             | independent 48+ bytes                                 | separate secret entry            | Rotate after draining MFA challenges (5 min TTL)                                                                     |
| `AUTH_TOKEN_PEPPER`          | independent 48+ bytes                                 | separate secret entry            | Rotating invalidates all opaque refresh/email/reset tokens; planned maintenance                                      |
| `AUTH_ENCRYPTION_KEY`        | 32 random bytes, base64                               | separate KMS/secret key          | **Requires re-encryption migration**; use a key-version prefix in a future change. Do not rotate without a migration |
| `PAYMENT_WEBHOOK_SECRET`     | 32+ random bytes                                      | provider + Secrets Manager       | Dual-secret verification window, then retire old                                                                     |
| Database/Redis credentials   | Terraform `random_password`/ElastiCache auth token    | Secrets Manager                  | Rotate via managed service; update ExternalSecret                                                                    |
| Prescription capability URLs | HMAC using `AUTH_TOKEN_PEPPER` with domain separation | derived, never stored            | Same as pepper; short 300 s TTL limits exposure                                                                      |

- Data at rest: RDS storage encryption + KMS key; ElastiCache at-rest and in-transit encryption; S3 SSE-KMS for exports; K8s Secrets encrypted at rest by the cluster KMS provider.
- In transit: TLS 1.2+ everywhere; `rediss://` requires Redis TLS. Local Compose uses plaintext because it is loopback-only.
- Secrets are not given defaults, are validated at startup, and are never logged. `.env` is gitignored; only `.env.example` is committed. Production should use External Secrets/Sealed Secrets, not env files in Git.

## 6. Audit and logging

- Audit entries include actor, role, action, resource type/id, request ID, source IP, user agent, before/after SHA-256 hashes, PHI-free metadata, previous hash, and entry hash.
- The global chain is serialised with `pg_advisory_xact_lock`. Modifying or deleting a historical row breaks verification; only admins can search/verify.
- Audit metadata must never include clinical free text. Tests assert the admin verification reason is not stored in metadata.
- API logs include method/path/status/latency/request ID; authorization headers, cookies, passwords, tokens, and refresh tokens are censored. Email addresses should be treated as PII; notification adapter logs omit recipients and encrypted tokens.
- Retention: audit ≥1 year online; application logs 30–90 days depending on policy; traces 7–30 days. Configure Loki/S3 lifecycle policies in production.
- Alerting: 5xx ratio, p95 latency, worker down, outbox backlog, DLQ non-empty, database availability. Alerts link to [runbooks.md](runbooks.md).

## 7. Secure SDLC and release checklist

- [x] No secrets committed; `.env` ignored; `.env.example` contains blanks/placeholders.
- [x] Startup fails on missing/weak secrets and invalid crypto keys.
- [x] Deny-by-default auth guards; explicit public allowlist.
- [x] Parameterised SQL and strict request validation.
- [x] Idempotency for unsafe availability, patient, clinical, and payment operations.
- [x] Audit and outbox atomic with state changes.
- [x] Migration checksums + advisory lock; no edits to applied migrations.
- [x] Multi-stage non-root container; read-only root filesystem and dropped capabilities in K8s.
- [x] CI: format, lint, typecheck, build, contract check, unit/e2e tests, npm audit, Trivy, SBOM, gitleaks, CodeQL.
- [x] Multi-stage IaC with encrypted managed data services and secrets.
- [x] Health/readiness, metrics, traces, dashboards, alerts, runbooks.
- [x] Backup/PITR and restore drill documentation.
- [ ] Endpoint-specific distributed rate limits and step-up auth for high-risk admin actions (recommended next).
- [ ] Automated external IDS/WAF and DDoS protection (deployment responsibility).
- [ ] Independent penetration test and clinical compliance review before handling real PHI.

## 8. Residual risks and explicit non-goals

1. **No real email/SMS provider** is bundled. The outbox notification handler is a PHI-safe adapter boundary; production must plug in SES/Twilio/FCM and retain delivery evidence.
2. **No field-level encryption for free-text clinical notes.** Database/KMS encryption at rest and TLS protect the volume; application-level field encryption would complicate search and prescription rendering.
3. **Global IP rate limit only.** Attackers with many IPs or authenticated abuse need edge rate limiting/risk scoring.
4. **Audit chain is internal to PostgreSQL.** An attacker with full DB write access could rewrite the chain. Ship chain heads to an external WORM/S3 Object Lock sink for stronger non-repudiation.
5. **Capability URLs can be forwarded.** Short TTL and authenticated issuance limit exposure; one-time tokens can be added.
6. **Payment adapter is a local ledger/mock.** The provider integration must implement idempotent authorise/capture/refund calls and webhook secret rotation.
7. **Analytics are direct indexed queries.** At much larger data volumes, move to read replicas/rollups and cap query concurrency.
