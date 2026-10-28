# ADR 0002: REST with an OpenAPI 3.1 contract

- Status: Accepted
- Date: 2026-10-27

## Context

The API is workflow-centric: authentication, availability lookup, booking, consultation transitions, prescriptions, payments, and analytics. Clients need predictable caching, idempotent retries, and measurable per-route latency. The assignment accepts REST or GraphQL and requires a published API schema.

## Decision

Expose a versioned REST API (`/api/v1`) and publish an OpenAPI 3.1 document as the contract. Use cursor pagination, a shared error envelope, and the `Idempotency-Key` header for retry-sensitive domain writes. The schema will be generated and validated in CI so implementation, tests, and documentation cannot drift.

## Consequences

- HTTP semantics (methods, status codes, conditional requests, rate-limit headers) map cleanly onto the booking workflow.
- Idempotency and per-route authorization are simpler to reason about than in a single GraphQL graph.
- Clients fetch fixed representations; over-fetching is limited by purpose-built endpoints and filterable projections.
- GraphQL remains an option in front of the same domain services if a future client needs flexible reads.
