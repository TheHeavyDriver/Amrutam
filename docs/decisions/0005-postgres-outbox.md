# 0005 — PostgreSQL outbox and scheduler instead of BullMQ

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

The assignment asks for asynchronous work after clinical writes: verification emails, reminders, no-show detection, cancellation refunds, payment reconciliation, slot cleanup, and DLQ replay. A common design is a transactional outbox relayed into BullMQ. That adds a second durability domain: an outbox row can commit while Redis loses the enqueue, or a queue job can run while the outbox row is still uncommitted.

The expected volume is roughly 1–2 domain events per second on average, with bursty peaks. At this scale PostgreSQL can serve the queue cheaply using `FOR UPDATE SKIP LOCKED`, while preserving the same transaction that writes clinical state and audit records.

## Decision

Use `outbox_events` as the durable queue and a stateless worker process as the dispatcher.

- Domain writes insert outbox rows in the same transaction as the state change.
- Workers claim bounded batches with `FOR UPDATE SKIP LOCKED`, increment attempts, and process handlers.
- Failures retry with exponential backoff plus jitter; exhausted events become `dead_letter`.
- Stale processing locks are recovered after a configurable timeout.
- Scheduled maintenance runs in the worker behind PostgreSQL advisory transaction locks, so replicas cannot double-run a job.
- A CLI (`jobs:status`, `jobs:replay`) provides operational DLQ tooling. Metrics expose pending, processing, and dead-letter depth.
- Handlers are idempotent; payment refunds and reminder deduplication have database-level guards.

## Consequences

**Positive**

- No dual-write failure between PostgreSQL and Redis.
- Audit, state, and asynchronous intent commit atomically.
- No extra broker to operate or secure for this workload.
- Worker replicas scale horizontally without coordination beyond row locks.

**Negative**

- Polling adds a small latency (default 1 s) and database load.
- Long-running handlers must stay short; large fan-out should be batched.
- If event throughput grows by orders of magnitude, PostgreSQL queue maintenance becomes expensive.

## Revisit triggers

Move to a relay + Kafka/SQS when sustained outbox depth is consistently above a few thousand events, handler fan-out becomes large, or database CPU from polling exceeds 10%. The outbox schema and dispatcher handler interface are designed so a relay can be added without changing domain services.
