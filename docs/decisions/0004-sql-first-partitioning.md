# ADR 0004: SQL-first PostgreSQL with partitioned clinical tables

- Status: Accepted
- Date: 2026-10-27

## Context

The delivery plan assumed Prisma plus hand-written SQL migrations. The clinical schema depends on database features that are either invisible to Prisma's schema or awkward to express there: exclusion constraints on time ranges, partially unique indexes, state-transition triggers, append-only enforcement, hash/range partitioning, and UUIDv7 defaults. The assignment also treats database-level invariants, especially one-booking-per-slot and prescription immutability, as core correctness requirements.

A migration layer must remain reviewable, checksummed, and reversible, and it must run identically from a developer laptop, CI, and a container.

## Decision

Use PostgreSQL as the system of record and access it through `pg` with explicit SQL in repositories. Do not add an ORM. Use a small in-repository migration runner that:

- discovers paired `NNNN_name.up.sql` / `NNNN_name.down.sql` files;
- stores a SHA-256 checksum of both directions in `schema_migrations`;
- serializes concurrent runs with a PostgreSQL advisory lock;
- applies each migration in its own transaction and refuses to run if an applied file has changed.

Partition `consultations` by hash of `id` into 16 partitions. This keeps `id` as the primary key, so prescriptions, payments, slot claims, and audit records can reference a consultation with simple foreign keys. It also avoids concentrating current-day writes in a single newest monthly partition. Range-partition append-only `audit_logs` by month for retention and cheap old-data archival. `ensure_audit_log_partition` and `ensure_audit_log_partitions` create future audit partitions; the scheduled job that calls them is added with the async job runner.

Booking exclusivity is enforced at the database boundary by a GiST exclusion constraint over `(doctor_id, tstzrange(starts_at, ends_at))` and a uniquely keyed `consultation_slot_claims` row per slot. Application code may return friendly errors, but it cannot create a double booking.

## Consequences

- Constraints are executable and testable, not conventions documented in application code.
- Repositories map typed rows by hand; there is no generated Prisma client to lean on, so query changes need integration coverage against real PostgreSQL.
- Hash partitioning keeps foreign keys simple but does not provide time-range pruning or a cheap monthly drop for consultations. Time-based access paths rely on the declared indexes, and archiving will be an explicit application job if it becomes necessary.
- The migration runner is deliberately small and unit-tested; editing an applied migration is detected as an error rather than silently drifting.
- Audit partitions have a finite runway created at migration time and a documented helper for scheduled maintenance.
