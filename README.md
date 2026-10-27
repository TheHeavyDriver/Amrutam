# Amrutam Telemedicine Backend

Production-grade backend for Amrutam's telemedicine platform, built to satisfy the assignment in [`description.md`](description.md): a secure, observable, and scalable service covering identity, doctor availability, booking, consultations, prescriptions, payments, audit trails, and admin analytics.

The work is tracked in [`todo.md`](todo.md); the detailed implementation roadmap lives in [`plans/2026-10-27-amrutam-telemedicine-backend-v1.md`](plans/2026-10-27-amrutam-telemedicine-backend-v1.md).

> **Current status:** Foundations, PostgreSQL clinical model, OpenAPI 3.1 contract, and the identity/audit core are implemented. The API supports registration, login, rotating refresh sessions, email verification/reset enqueueing, TOTP MFA with recovery codes, role guards, user profiles, and hash-chained audit records with an admin-only verification endpoint. Doctor discovery, booking, consultations, payments, prescriptions, and analytics are next.

## Stack

| Concern     | Choice                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Runtime     | Node.js 22+ (ESM), TypeScript 6                                            |
| Framework   | NestJS 12 with the Fastify adapter                                         |
| Validation  | Zod                                                                        |
| API         | OpenAPI 3.1 contract + generated TypeScript client                         |
| Logging     | pino via `nestjs-pino`, JSON in production, pretty locally                 |
| Database    | PostgreSQL 16, SQL-first migrations, `pg` (no ORM)                         |
| Cache/queue | Redis 7 (wired in later tasks)                                             |
| Tests       | Vitest + SWC (decorator metadata)                                          |
| Local infra | Docker Compose + OpenTelemetry collector, Prometheus, Grafana, Loki, Tempo |
| CI          | GitHub Actions (added in task 17)                                          |

## Quick start

Prerequisites: Node.js 22+, npm, Docker with Compose v2.

```bash
cp .env.example .env
npm run env:secrets # local-only random auth secrets; no values are printed
npm install
make up          # Postgres, Redis, and the observability stack
make db-migrate  # apply the schema
make db-seed     # deterministic demo data and demo credentials
npm run start:dev
```

Verify:

```bash
curl -s http://localhost:3000/health | jq
```

Or run the API in a container with its dependencies:

```bash
make app
```

The API listens on `http://localhost:3000`. Grafana runs at `http://localhost:3001` (default `admin` / `admin`), Prometheus at `http://localhost:9090`, and Tempo at `http://localhost:3200`.

## Endpoints

| Method  | Path                               | Description                         |
| ------- | ---------------------------------- | ----------------------------------- |
| `GET`   | `/health`                          | Service health snapshot             |
| `GET`   | `/health/live`                     | Liveness probe                      |
| `GET`   | `/health/ready`                    | Readiness probe                     |
| `POST`  | `/api/v1/auth/register`            | Register a patient                  |
| `POST`  | `/api/v1/auth/login`               | Password login or MFA challenge     |
| `POST`  | `/api/v1/auth/mfa/verify`          | Complete MFA and issue a session    |
| `POST`  | `/api/v1/auth/refresh`             | Rotate a refresh token              |
| `POST`  | `/api/v1/auth/logout`              | Revoke the current session          |
| `POST`  | `/api/v1/auth/verify-email`        | Consume an email verification token |
| `POST`  | `/api/v1/auth/resend-verification` | Re-enqueue email verification       |
| `POST`  | `/api/v1/auth/forgot-password`     | Enqueue a password reset            |
| `POST`  | `/api/v1/auth/reset-password`      | Complete a password reset           |
| `POST`  | `/api/v1/auth/mfa/setup`           | Begin TOTP enrollment               |
| `POST`  | `/api/v1/auth/mfa/enable`          | Confirm TOTP enrollment             |
| `POST`  | `/api/v1/auth/mfa/disable`         | Disable TOTP MFA                    |
| `GET`   | `/api/v1/users/me`                 | Read the current profile            |
| `PATCH` | `/api/v1/users/me`                 | Update the current profile          |
| `POST`  | `/api/v1/users/me/password`        | Change password                     |
| `GET`   | `/api/v1/admin/audit-logs`         | Search audit metadata (admin)       |
| `GET`   | `/api/v1/admin/audit-logs/verify`  | Verify the audit hash chain (admin) |

Public routes are health, registration, login, refresh, email/password recovery, and MFA challenge verification. Every other route requires a bearer access token; admin routes additionally require the `admin` role.

Health routes are intentionally served outside the `/api/v1` prefix so orchestrators can probe them without versioning. All other routes live under `/api/v1`.

Every response includes an `x-request-id` header. A client-supplied value is accepted only when it matches `[A-Za-z0-9._:-]{1,128}`; otherwise a UUID is generated. Errors use a consistent envelope:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Cannot GET /api/v1/unknown",
    "requestId": "0d3d5e3e-3d6b-4f3c-9c0d-6f8e0f0f0f0f"
  }
}
```

## Commands

| Command                 | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `make up` / `make down` | Start or stop local infrastructure                |
| `make reset`            | Stop infrastructure and delete volumes            |
| `make dev`              | Start infrastructure, then the API in watch mode  |
| `make app`              | Build and run the API container with dependencies |
| `make build`            | Compile to `dist/`                                |
| `make test`             | Run unit and end-to-end tests                     |
| `make test-cov`         | Run tests with coverage                           |
| `make lint`             | ESLint (type-aware)                               |
| `make typecheck`        | `tsc --noEmit`                                    |
| `make check`            | Lint, typecheck, and tests                        |
| `make format`           | Prettier                                          |
| `make db-migrate`       | Apply pending SQL migrations                      |
| `make db-rollback`      | Roll back the latest migration                    |
| `make db-status`        | Show applied and pending migrations               |
| `make db-seed`          | Load deterministic demo data (development only)   |
| `npm run api:validate`  | Lint the OpenAPI 3.1 contract                     |
| `npm run api:generate`  | Regenerate the TypeScript client                  |
| `npm run api:check`     | Validate the contract and typecheck the client    |

## API contract

The source of truth is [`openapi/openapi.yaml`](openapi/openapi.yaml). It covers health, auth/MFA, profiles, doctor discovery and availability, bookings and consultation lifecycle, payments and signed webhooks, prescriptions, admin verification, analytics, and audit search.

Conventions are defined once in the contract:

- bearer access tokens, rotating refresh tokens, and server-side role/ownership checks;
- required `Idempotency-Key` headers on unsafe clinical and payment writes;
- opaque cursor pagination with a 100-row cap;
- the shared `{ error: { code, message, requestId, details? } }` envelope;
- `X-Request-Id`, rate-limit headers, and `Retry-After` on throttled responses;
- RFC 3339 UTC timestamps and integer minor-unit money.

```bash
npm run api:validate              # Redocly lint against the recommended rules
npm run api:generate              # refresh clients/typescript/generated/api.ts
npm run api:check                 # validate + typecheck the generated client
```

Generated types and one function per operation are committed under [`clients/typescript`](clients/typescript/README.md), so contract drift is reviewable in diffs.

## Database

PostgreSQL is the source of truth. Migrations are paired, reversible SQL files in `db/migrations/`; the runner checksums both directions, takes a PostgreSQL advisory lock, and applies each migration transactionally. An applied migration must never be edited — add a new one instead. See [ADR 0004](docs/decisions/0004-sql-first-partitioning.md) for why the project is SQL-first and how partitioning is applied.

```bash
make up
npm run db:migrate          # apply all pending migrations
npm run db:status           # show applied/pending files
npm run db:rollback         # roll back one migration
npm run db:rollback -- --steps 3
npm run db:rollback -- --all
npm run db:seed             # deterministic admin, doctors, patients, slots, history
```

The seed is idempotent and intended for local demos and load tests. It prints the local demo password and TOTP secret; every seeded account uses password `DemoPass!2026`, and seeded doctors/admins use the printed shared TOTP secret. These credentials are deliberately local-only. The seed refuses to run with `NODE_ENV=production` unless `SEED_ALLOW=true` is explicitly set, and it requires the same `AUTH_ENCRYPTION_KEY` used by the running API so seeded TOTP secrets can be decrypted.

Migrations and seeds use `DATABASE_URL`. Set `POSTGRES_PORT` and `DATABASE_URL` together when changing local ports (the example defaults to 5432; a local `.env` can use another port). Production images contain the compiled migration CLI and the `db/` directory; run `node dist/database/cli.js up` before starting a new API revision.

## Configuration

Configuration is validated at startup with Zod; invalid values fail fast with a readable error. See [`.env.example`](.env.example) for the full list.

| Variable                                           | Default                 | Notes                                                          |
| -------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `NODE_ENV`                                         | `development`           | `development` \| `test` \| `production`                        |
| `HOST` / `PORT`                                    | `0.0.0.0` / `3000`      | HTTP bind address                                              |
| `API_GLOBAL_PREFIX`                                | `api/v1`                | Prefix for all non-health routes                               |
| `BODY_LIMIT_BYTES`                                 | `1048576`               | Maximum request body                                           |
| `TRUST_PROXY`                                      | `true`                  | Honour `X-Forwarded-*` behind a load balancer                  |
| `CORS_ORIGINS`                                     | localhost clients       | Comma-separated allow list                                     |
| `LOG_LEVEL`                                        | `info`                  | `trace` … `fatal`, `silent`                                    |
| `LOG_PRETTY`                                       | auto                    | Pretty in development, JSON elsewhere                          |
| `DATABASE_URL`                                     | local Postgres          | PostgreSQL connection string                                   |
| `DATABASE_POOL_MAX`                                | `10`                    | PostgreSQL pool size                                           |
| `REDIS_URL`                                        | local Redis             | Redis connection string                                        |
| `APP_PUBLIC_URL`                                   | `http://localhost:3000` | Public base URL used in links                                  |
| `JWT_ACCESS_SECRET`                                | required                | Access-token HMAC key, 32+ characters                          |
| `JWT_MFA_SECRET`                                   | required                | Separate MFA challenge-token key                               |
| `AUTH_TOKEN_PEPPER`                                | required                | HMAC pepper for opaque refresh/email tokens                    |
| `AUTH_ENCRYPTION_KEY`                              | required                | Base64 32-byte AES-256-GCM key                                 |
| `AUTH_REQUIRE_EMAIL_VERIFICATION`                  | `true`                  | Set `false` only for local/test setups without an email worker |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                    | `900`                   | Access token lifetime                                          |
| `AUTH_REFRESH_TOKEN_TTL_SECONDS`                   | `2592000`               | Refresh session lifetime                                       |
| `AUTH_MAX_LOGIN_ATTEMPTS` / `AUTH_LOCKOUT_SECONDS` | `5` / `900`             | Lockout policy                                                 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS`     | `300` / `60`            | Global per-IP limit                                            |

Secrets are supplied through environment variables and are never committed or given defaults. `npm run env:secrets` fills missing local values without printing them; run it only against a development `.env`.

## Project structure

```
src/
  common/          # filters, guards, auth decorators, security primitives, logging
  config/          # zod env schema and typed config service
  database/        # pool, migration runner, CLI, deterministic seed
  modules/auth/    # registration, sessions, MFA, password/email flows
  modules/users/   # current-user profile endpoints
  modules/audit/   # tamper-evident audit append, search, chain verification
  modules/health/  # liveness and readiness endpoints
  app.module.ts    # composition root and global guards
  bootstrap.ts     # startup, adapters, shutdown
  main.ts          # entrypoint
db/migrations/     # paired, reversible SQL migrations
openapi/           # OpenAPI 3.1 contract
clients/typescript/# generated typed API client
scripts/           # local developer utilities (never production secrets)
test/              # end-to-end tests and helpers
infra/             # observability configuration
docs/decisions/    # architecture decision records
```

Module layout is intentionally folder-per-domain (`identity`, `doctors`, `scheduling`, `consultations`, `prescriptions`, `payments`, `analytics`, `audit`) as each phase lands.

## Observability

The Compose stack includes an OpenTelemetry collector receiving OTLP on `4317`/`4318`, Prometheus scraping the collector, Tempo for traces, Loki for logs, and Grafana provisioned with all three datasources. Application-level tracing, metrics, and dashboards are added in Phase 3 (task 14); until then the stack is ready to receive data.

## Testing

```bash
npm test              # unit + e2e; requires a migrated/seeded test database
npm run test:unit     # src/**/*.spec.ts
npm run test:e2e      # test/**/*.e2e-spec.ts
npm run test:cov      # coverage report
```

The auth/audit e2e suite expects PostgreSQL. Create a dedicated database, apply migrations, and seed it with the same test encryption key (the test harness uses `Buffer.alloc(32, 7).toString('base64')` by default):

```bash
createdb -h localhost -p 5432 -U amrutam amrutam_test
DATABASE_URL=postgresql://amrutam:amrutam@localhost:5432/amrutam_test npm run db:migrate
DATABASE_URL=postgresql://amrutam:amrutam@localhost:5432/amrutam_test \
  AUTH_ENCRYPTION_KEY="$(node -e "process.stdout.write(Buffer.alloc(32,7).toString('base64'))")" \
  npm run db:seed
TEST_DATABASE_URL=postgresql://amrutam:amrutam@localhost:5432/amrutam_test npm test
```

Tests run against the Fastify instance through `app.inject()`, so they exercise the real middleware, filters, and plugins without binding a port. The e2e suite uses unique account identifiers so it can run repeatedly without a database wipe; audit records are intentionally retained.

## Documentation

- [Architecture decisions](docs/decisions/README.md)
- [Implementation roadmap](plans/2026-10-27-amrutam-telemedicine-backend-v1.md)
- [Task tracker](todo.md)
- Architecture document, ERD, OpenAPI schema, threat model, and runbooks are added in their respective phases.
