# Architecture Decision Records

Short, immutable records of decisions that shape the system. Each entry states the context, the decision, and the consequences so reviewers can judge trade-offs rather than infer them.

| ADR                                    | Title                                                 | Status   |
| -------------------------------------- | ----------------------------------------------------- | -------- |
| [0001](0001-modular-monolith.md)       | Modular monolith on NestJS and Fastify                | Accepted |
| [0002](0002-rest-openapi.md)           | REST with an OpenAPI 3.1 contract                     | Accepted |
| [0003](0003-idempotency-keys.md)       | Database-backed idempotency for unsafe writes         | Accepted |
| [0004](0004-sql-first-partitioning.md) | SQL-first PostgreSQL with partitioned clinical tables | Accepted |

New decisions get the next number and are never rewritten; supersede an old ADR with a new one that links back to it.
