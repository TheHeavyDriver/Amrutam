# k6 load test

The scenario drives the two most important paths at the scale target:

- **Browse:** doctor search + availability reads (p95 <200 ms).
- **Book/cancel:** idempotent writes with slot contention (p95 <500 ms).

100,000 consultations/day is ≈1.16 consultations/s average. The defaults use 50 browse VUs and 10 write VUs, which is intentionally above a smooth average so it exercises bursts. Increase `BROWSE_VUS`/`WRITE_VUS` to model the peak factor and record p95/p99, error rate, CPU, DB connections, and outbox lag.

## Run

```bash
# Fresh, seeded, migrated environment with the API running.
docker compose up -d db redis
make db-migrate db-seed
npm run start:dev

API_BASE_URL=http://localhost:3000 k6 run load/k6/booking-flow.js
```

If `k6` is not installed:

```bash
docker run --rm --network host -e API_BASE_URL=http://localhost:3000 \
  -v "$PWD/load/k6:/scripts" grafana/k6 run /scripts/booking-flow.js
```

On macOS use `host.docker.internal` instead of `localhost`, or run k6 on the host.

## Thresholds

| Threshold         | Target             |
| ----------------- | ------------------ |
| `http_req_failed` | <1%                |
| browse p95 / p99  | <200 ms / <500 ms  |
| write p95 / p99   | <500 ms / <1200 ms |
| checks            | >99%               |

The test creates and cancels consultations. Reset the database before comparing runs:

```bash
TEST_DATABASE_URL=postgresql://amrutam:amrutam@localhost:5435/amrutam_test npm test
```

For a production-like run, use a dedicated staging database, enable Redis, run the worker, and observe Prometheus alongside k6. Capture the raw k6 summary and the dashboard screenshots/logs as evidence. If thresholds fail, inspect `EXPLAIN (ANALYZE, BUFFERS)` for the slow route, pool saturation, lock waits, and Redis hit rate before changing indexes.
