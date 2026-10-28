# ADR 0003: Database-backed idempotency for unsafe writes

- Status: Accepted
- Date: 2026-10-27

## Context

The assignment treats missing idempotency as an automatic failure. Mobile clients retry on flaky networks, payment providers replay webhooks, and users double-tap booking buttons. A booking retry must never create a second consultation, charge twice, or hold two slots.

## Decision

Require an `Idempotency-Key` header on retry-sensitive domain endpoints (availability, booking, consultation, prescription, payment, and admin verification). Authentication endpoints use their own replay/token protections. Persist a row in `idempotency_keys` containing:

- the key, caller identity, route, and a fingerprint of the request body;
- a unique constraint on `(caller_id, key)`;
- the response status and body for completed requests;
- an `in_progress` marker for concurrent requests;
- a creation timestamp with a bounded retention window (initial target: 24 hours).

The first request acquires the key with an atomic insert. Concurrent duplicates either wait briefly for the original response or receive `409 IDEMPOTENCY_IN_PROGRESS`. Replays with the same fingerprint return the stored response; a different fingerprint for the same key returns `422 IDEMPOTENCY_KEY_REUSED`.

The idempotency record and the business transaction are committed together where possible; the payment saga records its progress so a retry resumes rather than restarts.

## Consequences

- Retries are safe across process restarts and multiple API replicas.
- Every retry-sensitive domain write pays one extra indexed write; acceptable at the target throughput.
- Keys and stored responses contain no PHI beyond what the original response returned.
- Retention must be enforced by a scheduled job and documented for clients.
