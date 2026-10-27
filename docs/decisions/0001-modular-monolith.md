# ADR 0001: Modular monolith on NestJS and Fastify

- Status: Accepted
- Date: 2026-10-27

## Context

The assignment requires modular services with dependency injection, clear domain boundaries, and the operational maturity of a much larger system, while one developer delivers it in roughly ten working days. The expected load (100k consultations/day, about 1.2 req/s average with burst traffic) does not justify distributed transactions or per-service deployment overhead.

## Decision

Build a single deployable TypeScript service using NestJS with the Fastify adapter, organized as a modular monolith. Domain modules are `identity`, `doctors`, `scheduling`, `consultations`, `prescriptions`, `payments`, `analytics`, and `audit`. Modules communicate through injected interfaces and domain events, never by reaching into another module's persistence layer. Cross-cutting concerns live in `common/`.

Fastify is used instead of Express for lower per-request overhead, first-class schema-based serialization opportunities, and built-in request-scoped logging. Nest provides DI, module boundaries, guards, interceptors, and lifecycle hooks that map directly to RBAC and idempotency requirements.

## Consequences

- One repository, one build, one deployment; local development and CI stay cheap.
- Module boundaries must be reviewed deliberately because the compiler does not enforce them.
- The architecture can be split into services later along existing module seams if scaling demands it.
- The Fastify adapter means some Express middleware cannot be used directly; Fastify-native plugins are preferred.
