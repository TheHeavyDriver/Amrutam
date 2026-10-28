# Backup, recovery, and disaster recovery

## Objectives

| Metric               | Target                                                        | Basis                                                                                                              |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **RPO**              | ≤5 minutes                                                    | RDS continuous WAL archiving + automated backups; ElastiCache snapshots are best-effort (cache is reconstructible) |
| **RTO**              | ≤60 minutes for regional/zonal database failure               | Multi-AZ automatic failover; documented restore path for logical corruption                                        |
| **Backup retention** | 35 days automated + monthly long-term snapshots for 12 months | RDS retention; S3 lifecycle for monthly exports                                                                    |
| **Restore drill**    | Quarterly, plus before any major migration                    | `scripts/restore-drill.sh` against an isolated database                                                            |

The API concentrates state in PostgreSQL. Redis is a cache and can be lost without data loss; outbox rows, audit records, clinical state, refunds, and idempotency records are all in PostgreSQL.

## Production backup configuration (Terraform)

- RDS PostgreSQL Multi-AZ with `backup_retention_period = 35`, automated backups, `copy_tags_to_snapshot`, deletion protection, encrypted storage with a customer-managed KMS key, and Performance Insights.
- Continuous WAL archiving enables **point-in-time recovery** to any second in the retention window.
- Automated snapshots are copied to a secondary region for regional disaster recovery (add an AWS Backup vault/plan or cross-region snapshot copy in the target account).
- Monthly `pg_dump` logical exports are written to S3 with SSE-KMS, versioning, public access blocked, and lifecycle transition to Glacier after 90 days.
- Audit/application logs have independent retention in Loki/S3; they are not a substitute for database backups.
- ElastiCache has automatic snapshots where supported, but **Redis is not an RPO dependency**.

## Restore procedure — PITR (preferred for logical corruption)

1. Declare an incident and freeze writes (scale API/worker to zero or put the service in maintenance mode).
2. Identify the last known-good UTC timestamp **before** the damaging write.
3. In AWS RDS, choose **Restore to point in time**, select the timestamp, and restore to a new instance in the same VPC/subnet group/security group.
4. Validate the restored instance:
   - `SELECT count(*)`, max timestamps, and checksum summaries for `users`, `consultations`, `payments`, `payment_refunds`, `audit_logs`.
   - Run `node dist/database/cli.js status` against the restored DB; schema checksums must match the deployment revision.
   - Verify the audit chain with the admin verification endpoint against the restored copy.
5. Point the application `DATABASE_URL` secret at the restored instance (or promote a read replica after replaying WAL).
6. Scale up the API and one worker, run booking/payment smoke tests, then scale workers.
7. Reconcile payments made during the outage with the provider dashboard; the outbox/reconciliation job catches captured payments on cancelled consultations.
8. Preserve the failed instance/snapshot for forensic analysis; do not delete it until the incident review closes.

## Restore procedure — logical dump

For an isolated environment, a data corruption limited to a few rows, or a compliance export:

```bash
# 1. Create an isolated target database (never restore over production).
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" amrutam_restore

# 2. Restore the most recent verified dump.
pg_restore --clean --if-exists --no-owner --no-privileges \
  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d amrutam_restore /backups/amrutam.dump

# 3. Apply any migrations newer than the dump.
DATABASE_URL="postgresql://.../amrutam_restore" node dist/database/cli.js up

# 4. Verify counts/checksums and audit chain before cutover.
psql "$RESTORE_URL" -f scripts/verify-restore.sql
```

Use `scripts/backup.sh` for local/staging dumps. It writes a timestamped custom-format dump and SHA-256 sidecar; verify with `sha256sum -c` before restoring.

## Restore drill

`scripts/restore-drill.sh` automates an isolated restore and a set of integrity checks. It refuses to run against a database whose name does not contain `_restore` or `_test`. Use PostgreSQL client binaries whose major version matches the server (RDS 16); otherwise a newer client can emit settings that an older server rejects. Override `PG_DUMP_BIN`, `PG_RESTORE_BIN`, and `PSQL_BIN` when needed.

```bash
SOURCE_DATABASE_URL=postgresql://.../amrutam \
  TARGET_DATABASE_URL=postgresql://.../amrutam_restore \
  ./scripts/restore-drill.sh
```

The drill checks:

- migration status has no pending migrations;
- row counts for core tables are non-zero;
- every active consultation (scheduled/in-progress/completed) has a slot claim; cancelled and no-show consultations are expected to have released theirs;
- no payment has refunded more than captured;
- audit chain verification SQL returns no broken links;
- outbox dead-letter depth is reported;
- elapsed time is printed for RTO tracking.

Record the result in the incident/DR log. A drill that only restores the database is not complete until the API readiness endpoint returns 200 against the restored copy.

## Failure scenarios

| Scenario                          | Recovery                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single AZ failure                 | RDS/ElastiCache multi-AZ failover; API replicas in other zones continue; readiness may briefly fail                                                            |
| Primary DB instance loss          | RDS automated failover (typically 60–120 s); connection pools reconnect; verify outbox lag                                                                     |
| Accidental `DELETE`/bad migration | PITR to a new instance, validate, repoint secret; never repair production by editing the audit chain                                                           |
| Region loss                       | Restore cross-region snapshot/PITR copy, apply Terraform in the DR region, update DNS and secrets; run smoke tests; RTO depends on cross-region copy freshness |
| Redis loss                        | API serves from PostgreSQL; cache warms automatically; no RPO impact                                                                                           |
| Worker loss                       | Clinical writes continue; outbox backlog grows; scale worker and replay DLQ after the cause is fixed                                                           |
| Secret compromise                 | Rotate at the provider/secret manager, roll deployments, revoke sessions; rotate DB/Redis credentials through managed service; audit access logs               |

## Verification SQL

`scripts/verify-restore.sql` contains the integrity queries used by the drill. It is intentionally read-only. Expected results:

- `pending_migrations` must be zero (or documented and applied before cutover).
- `consultations_without_claim` must be zero.
- `over_refunded_payments` must be zero.
- `broken_audit_links` must be zero.
- Core table counts should match the source within the outage window; investigate any unexplained delta.
