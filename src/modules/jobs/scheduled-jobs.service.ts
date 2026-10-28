import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';

interface NoShowCandidate {
  id: string;
  patient_id: string;
  doctor_id: string;
  slot_id: string;
  scheduled_start: Date;
  scheduled_end: Date;
}

interface ReminderRow {
  consultation_id: string;
  patient_id: string;
  reminder_type: string;
  scheduled_start: Date;
}

const NO_SHOW_GRACE = "interval '15 minutes'";

@Injectable()
export class ScheduledJobsService implements OnModuleDestroy {
  private readonly logger = new Logger(ScheduledJobsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;
  private lastMaintenanceAt = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const interval = this.config.jobs.schedulerIntervalMs;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick();
    this.logger.log({ intervalMs: interval }, 'Scheduled jobs started');
  }

  async stop(): Promise<void> {
    this.closed = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async runOnce(): Promise<void> {
    await this.releaseExpiredSlotHolds();
    await this.detectNoShows();
    await this.enqueueReminders();
    await this.reconcileCancelledPayments();

    if (Date.now() - this.lastMaintenanceAt >= 3_600_000) {
      await this.ensureAuditPartitions();
      await this.cleanupExpiredIdempotencyKeys();
      this.lastMaintenanceAt = Date.now();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async tick(): Promise<void> {
    if (this.running || this.closed) {
      return;
    }

    this.running = true;

    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Scheduled jobs tick failed',
      );
    } finally {
      this.running = false;
    }
  }

  private async releaseExpiredSlotHolds(): Promise<void> {
    await this.withLock('jobs:release-holds', async (client) => {
      const { rowCount } = await client.query(
        `UPDATE availability_slots
            SET status = 'available',
                hold_expires_at = NULL
          WHERE status = 'held'
            AND hold_expires_at IS NOT NULL
            AND hold_expires_at < now()`,
      );

      if ((rowCount ?? 0) > 0) {
        this.logger.log({ released: rowCount }, 'Released expired slot holds');
      }
    });
  }

  private async detectNoShows(): Promise<void> {
    await this.withLock('jobs:no-show', async (client) => {
      const { rows } = await client.query<NoShowCandidate>(
        `SELECT id, patient_id, doctor_id, slot_id, scheduled_start, scheduled_end
           FROM consultations
          WHERE status = 'scheduled'
            AND scheduled_end < now() - ${NO_SHOW_GRACE}
          ORDER BY scheduled_end ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 100`,
      );

      for (const row of rows) {
        const updated = await client.query(
          `UPDATE consultations
              SET status = 'no_show',
                  no_show_at = now(),
                  no_show_notes = COALESCE(
                    no_show_notes,
                    'Marked automatically after the scheduled end time.'
                  ),
                  join_token_hash = NULL,
                  join_token_expires_at = NULL
            WHERE id = $1
              AND status = 'scheduled'`,
          [row.id],
        );

        if ((updated.rowCount ?? 0) === 0) {
          continue;
        }

        // A no-show frees the slot for another patient. Keep the claim and slot
        // update in the same transaction as the status change.
        await client.query('DELETE FROM consultation_slot_claims WHERE consultation_id = $1', [
          row.id,
        ]);
        await client.query(
          `UPDATE availability_slots
              SET status = 'available',
                  hold_expires_at = NULL
            WHERE id = $1
              AND status = 'booked'`,
          [row.slot_id],
        );

        await client.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('consultation', $1, 'consultation.no_show', $2::jsonb)`,
          [
            row.id,
            JSON.stringify({
              consultationId: row.id,
              patientId: row.patient_id,
              doctorId: row.doctor_id,
              scheduledStart: row.scheduled_start.toISOString(),
              detectedBy: 'scheduler',
            }),
          ],
        );

        await this.audit.record(
          {
            actorId: null,
            actorRole: null,
            action: 'consultation.no_show',
            resourceType: 'consultation',
            resourceId: row.id,
            request: { requestId: `job:no-show:${row.id}` },
            before: { status: 'scheduled' },
            after: { status: 'no_show' },
            metadata: {
              source: 'scheduler',
              slotId: row.slot_id,
              scheduledStart: row.scheduled_start.toISOString(),
            },
          },
          client,
        );
      }

      if (rows.length > 0) {
        this.logger.log({ detected: rows.length }, 'Marked overdue consultations as no-show');
      }
    });
  }

  private async enqueueReminders(): Promise<void> {
    await this.withLock('jobs:reminders', async (client) => {
      const { rows } = await client.query<ReminderRow>(
        `WITH candidates AS (
           SELECT c.id AS consultation_id,
                  c.patient_id,
                  c.scheduled_start,
                  reminder_window.reminder_type
             FROM consultations c
             CROSS JOIN (
               VALUES ('24h', interval '24 hours'), ('1h', interval '1 hour')
             ) AS reminder_window(reminder_type, lead_time)
            WHERE c.status = 'scheduled'
              AND c.scheduled_start > now()
              AND c.scheduled_start <= now() + reminder_window.lead_time
              AND NOT EXISTS (
                SELECT 1
                  FROM consultation_reminders reminder
                 WHERE reminder.consultation_id = c.id
                   AND reminder.reminder_type = reminder_window.reminder_type
              )
         ),
         inserted AS (
           INSERT INTO consultation_reminders (
             consultation_id, reminder_type, scheduled_for
           )
           SELECT consultation_id, reminder_type, scheduled_start
             FROM candidates
           ON CONFLICT (consultation_id, reminder_type) DO NOTHING
           RETURNING consultation_id, reminder_type
         )
         SELECT i.consultation_id,
                c.patient_id,
                i.reminder_type,
                c.scheduled_start
           FROM inserted i
           JOIN consultations c ON c.id = i.consultation_id`,
      );

      for (const reminder of rows) {
        await client.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('consultation', $1, 'consultation.reminder_due', $2::jsonb)`,
          [
            reminder.consultation_id,
            JSON.stringify({
              consultationId: reminder.consultation_id,
              patientId: reminder.patient_id,
              reminderType: reminder.reminder_type,
              scheduledStart: reminder.scheduled_start.toISOString(),
            }),
          ],
        );
      }

      if (rows.length > 0) {
        this.logger.log({ enqueued: rows.length }, 'Enqueued consultation reminders');
      }
    });
  }

  private async reconcileCancelledPayments(): Promise<void> {
    await this.withLock('jobs:payment-reconciliation', async (client) => {
      const { rows } = await client.query<{ id: string; consultation_id: string }>(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         SELECT 'payment', p.id, 'payment.refund_requested',
                jsonb_build_object(
                  'paymentId', p.id,
                  'consultationId', p.consultation_id,
                  'reason', 'cancelled_consultation_reconciliation'
                )
           FROM payments p
           JOIN consultations c ON c.id = p.consultation_id
          WHERE c.status = 'cancelled'
            AND p.status IN ('captured', 'partially_refunded')
            AND NOT EXISTS (
              SELECT 1
                FROM outbox_events o
               WHERE o.aggregate_id = p.id
                 AND o.event_type = 'payment.refund_requested'
            )
         RETURNING aggregate_id AS id, (payload->>'consultationId') AS consultation_id`,
      );

      if (rows.length > 0) {
        this.logger.log(
          { enqueued: rows.length },
          'Reconciled captured payments for cancelled consultations',
        );
      }
    });
  }

  private async ensureAuditPartitions(): Promise<void> {
    await this.withLock('jobs:audit-partitions', async (client) => {
      const { rows } = await client.query<{ partition: string }>(
        `SELECT ensure_audit_log_partition(
           (date_trunc('month', now()) + make_interval(months => month_offset))::date
         ) AS partition
           FROM generate_series(0, 4) AS month_offset`,
      );
      this.logger.log(
        { partitions: rows.map((row) => row.partition) },
        'Ensured audit log partitions',
      );
    });
  }

  private async cleanupExpiredIdempotencyKeys(): Promise<void> {
    await this.withLock('jobs:idempotency-cleanup', async (client) => {
      const { rowCount } = await client.query(
        `WITH expired AS (
           SELECT id
             FROM idempotency_keys
            WHERE expires_at < now()
            LIMIT 5000
         )
         DELETE FROM idempotency_keys keys
          USING expired
          WHERE keys.id = expired.id`,
      );

      if ((rowCount ?? 0) > 0) {
        this.logger.log({ deleted: rowCount }, 'Deleted expired idempotency keys');
      }
    });
  }

  private async withLock(name: string, work: (client: PoolClient) => Promise<void>): Promise<void> {
    await this.database.withTransaction(async (client) => {
      const { rows } = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
        [name],
      );

      if (!rows[0]?.acquired) {
        return;
      }

      await work(client);
    });
  }
}
