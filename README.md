# Amrutam Telemedicine Backend

Production-grade backend for Amrutam's telemedicine platform, built to satisfy the assignment in [`description.md`](description.md): a secure, observable, and scalable service covering identity, doctor availability, booking, consultations, prescriptions, payments, audit trails, and admin analytics.

The work is tracked in [`todo.md`](todo.md); the detailed implementation roadmap lives in [`plans/2026-10-27-amrutam-telemedicine-backend-v1.md`](plans/2026-10-27-amrutam-telemedicine-backend-v1.md).

> **Current status:** Phase 0 foundations. The service boots with typed configuration, structured logging, request ids, a consistent error envelope, health probes, security headers, compression, Docker/Compose infrastructure, and a CI-ready test harness. Clinical domain work starts with the database schema (task 2).

## Stack

| Concern     | Choice                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Runtime     | Node.js 22+ (ESM), TypeScript 6                                            |
| Framework   | NestJS 12 with the Fastify adapter                                         |
| Validation  | Zod                                                                        |
| Logging     | pino via `nestjs-pino`, JSON in production, pretty locally                 |
| Database    | PostgreSQL 16 (wired in task 2)                                            |
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
  modules/health/  # liveness and readiness endpoints
  app.module.ts    # composition root
  bootstrap.ts     # startup, adapters, shutdown
  main.ts          # entrypoint
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
