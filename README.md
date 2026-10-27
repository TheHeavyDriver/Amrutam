# Amrutam Telemedicine Backend

Production-grade backend for Amrutam's telemedicine platform, built to satisfy the assignment in [`description.md`](description.md): a secure, observable, and scalable service covering identity, doctor availability, booking, consultations, prescriptions, payments, audit trails, and admin analytics.

The work is tracked in [`todo.md`](todo.md); the detailed implementation roadmap lives in [`plans/2026-10-27-amrutam-telemedicine-backend-v1.md`](plans/2026-10-27-amrutam-telemedicine-backend-v1.md).

> **Current status:** Phase 0 foundations, the PostgreSQL clinical data model, and the complete OpenAPI 3.1 contract. The service boots with typed configuration, structured logging, request ids, a consistent error envelope, health probes, security headers, compression, Docker/Compose infrastructure, and a CI-ready test harness. Migrations, deterministic demo data, database-level booking/clinical invariants, and a generated TypeScript client are in place. The runtime API is still health-only; domain controllers land next.

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
npm install
make up          # Postgres, Redis, and the observability stack
make db-migrate  # apply the schema
make db-seed     # optional deterministic demo data
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

| Method | Path            | Description             |
| ------ | --------------- | ----------------------- |
| `GET`  | `/health`       | Service health snapshot |
| `GET`  | `/health/live`  | Liveness probe          |
| `GET`  | `/health/ready` | Readiness probe         |

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

The seed is idempotent and intended for local demos and load tests. Seeded privileged accounts have deliberately unusable password/MFA placeholders until identity is implemented; do not treat them as credentials. The seed refuses to run with `NODE_ENV=production` unless `SEED_ALLOW=true` is explicitly set.

Migrations and seeds use `DATABASE_URL`. Set `POSTGRES_PORT` and `DATABASE_URL` together when changing local ports (the example defaults to 5432; a local `.env` can use another port). Production images contain the compiled migration CLI and the `db/` directory; run `node dist/database/cli.js up` before starting a new API revision.

## Configuration

Configuration is validated at startup with Zod; invalid values fail fast with a readable error. See [`.env.example`](.env.example) for the full list.

| Variable            | Default            | Notes                                         |
| ------------------- | ------------------ | --------------------------------------------- |
| `NODE_ENV`          | `development`      | `development` \| `test` \| `production`       |
| `HOST` / `PORT`     | `0.0.0.0` / `3000` | HTTP bind address                             |
| `API_GLOBAL_PREFIX` | `api/v1`           | Prefix for all non-health routes              |
| `BODY_LIMIT_BYTES`  | `1048576`          | Maximum request body                          |
| `TRUST_PROXY`       | `true`             | Honour `X-Forwarded-*` behind a load balancer |
| `CORS_ORIGINS`      | localhost clients  | Comma-separated allow list                    |
| `LOG_LEVEL`         | `info`             | `trace` … `fatal`, `silent`                   |
| `LOG_PRETTY`        | auto               | Pretty in development, JSON elsewhere         |
| `DATABASE_URL`      | local Postgres     | PostgreSQL connection string                  |
| `REDIS_URL`         | local Redis        | Redis connection string                       |

Secrets are supplied through environment variables and are never committed.

## Project structure

```
src/
  common/          # cross-cutting filters, logging, errors
  config/          # zod env schema and typed config service
  database/        # migration runner, CLI, deterministic seed
  modules/health/  # liveness and readiness endpoints
  app.module.ts    # composition root
  bootstrap.ts     # startup, adapters, shutdown
  main.ts          # entrypoint
db/migrations/     # paired, reversible SQL migrations
openapi/           # OpenAPI 3.1 contract
clients/typescript/# generated typed API client
test/              # end-to-end tests and helpers
infra/             # observability configuration
docs/decisions/    # architecture decision records
```

Module layout is intentionally folder-per-domain (`identity`, `doctors`, `scheduling`, `consultations`, `prescriptions`, `payments`, `analytics`, `audit`) as each phase lands.

## Observability

The Compose stack includes an OpenTelemetry collector receiving OTLP on `4317`/`4318`, Prometheus scraping the collector, Tempo for traces, Loki for logs, and Grafana provisioned with all three datasources. Application-level tracing, metrics, and dashboards are added in Phase 3 (task 14); until then the stack is ready to receive data.

## Testing

```bash
npm test              # unit + e2e
npm run test:unit     # src/**/*.spec.ts
npm run test:e2e      # test/**/*.e2e-spec.ts
npm run test:cov      # coverage report
```

Tests run against the Fastify instance through `app.inject()`, so they exercise the real middleware, filters, and plugins without binding a port.

## Documentation

- [Architecture decisions](docs/decisions/README.md)
- [Implementation roadmap](plans/2026-10-27-amrutam-telemedicine-backend-v1.md)
- [Task tracker](todo.md)
- Architecture document, ERD, OpenAPI schema, threat model, and runbooks are added in their respective phases.
