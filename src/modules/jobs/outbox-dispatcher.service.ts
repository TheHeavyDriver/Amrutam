import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { MetricsService } from '../../metrics/metrics.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { NotificationService } from './notification.service.js';

interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface BacklogRow {
  pending: string;
  processing: string;
  dead_letter: string;
}

const WORKER_ID = `${process.pid}`;

@Injectable()
export class OutboxDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly tracer = trace.getTracer('amrutam-worker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private closed = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationService,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const interval = this.config.jobs.outbox.pollIntervalMs;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    void this.tick();
    this.logger.log({ intervalMs: interval, workerId: WORKER_ID }, 'Outbox dispatcher started');
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

  async processAvailableEvents(): Promise<number> {
    await this.recoverStaleLocks();
    const claimed = await this.claimBatch();
    let processed = 0;

    for (const event of claimed) {
      const success = await this.processEvent(event);

      if (success) {
        processed += 1;
      }
    }

    await this.refreshBacklog();
    return processed;
  }

  async refreshBacklog(): Promise<void> {
    const { rows } = await this.database.query<BacklogRow>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'processing')::text AS processing,
              count(*) FILTER (WHERE status = 'dead_letter')::text AS dead_letter
         FROM outbox_events
        WHERE status IN ('pending', 'processing', 'dead_letter')`,
    );
    const row = rows[0];

    if (!row) {
      return;
    }

    this.metrics.setOutboxBacklog('pending', Number(row.pending));
    this.metrics.setOutboxBacklog('processing', Number(row.processing));
    this.metrics.setOutboxBacklog('dead_letter', Number(row.dead_letter));
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
      // Drain in bounded batches so a large replay cannot monopolize the loop.
      for (let batch = 0; batch < 10; batch += 1) {
        const processed = await this.processAvailableEvents();

        if (processed === 0) {
          break;
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Outbox dispatch tick failed',
      );
    } finally {
      this.running = false;
    }
  }

  private async recoverStaleLocks(): Promise<void> {
    const options = this.config.jobs.outbox;
    await this.database.query(
      `UPDATE outbox_events
          SET status = CASE WHEN attempts >= $2 THEN 'dead_letter'::outbox_status
                            ELSE 'pending'::outbox_status END,
              available_at = now(),
              locked_at = NULL,
              locked_by = NULL,
              last_error = CASE WHEN attempts >= $2
                                THEN COALESCE(last_error, 'Worker lock expired')
                                ELSE last_error END
        WHERE status = 'processing'
          AND locked_at < now() - ($1 * interval '1 second')`,
      [options.lockTimeoutSeconds, options.maxAttempts],
    );
  }

  private async claimBatch(): Promise<OutboxEventRow[]> {
    const options = this.config.jobs.outbox;
    const { rows } = await this.database.query<OutboxEventRow>(
      `WITH candidate AS (
         SELECT id
           FROM outbox_events
          WHERE status = 'pending'
            AND available_at <= now()
          ORDER BY available_at ASC, created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE outbox_events event
          SET status = 'processing',
              locked_at = now(),
              locked_by = $2,
              attempts = event.attempts + 1
         FROM candidate
        WHERE event.id = candidate.id
        RETURNING event.id,
                  event.aggregate_type,
                  event.aggregate_id,
                  event.event_type,
                  event.payload,
                  event.attempts`,
      [options.batchSize, WORKER_ID],
    );

    return rows;
  }

  private async processEvent(event: OutboxEventRow): Promise<boolean> {
    return this.tracer.startActiveSpan(
      'outbox.process',
      {
        attributes: {
          'outbox.event_id': event.id,
          'outbox.event_type': event.event_type,
          'outbox.aggregate_type': event.aggregate_type,
          'outbox.attempt': event.attempts,
        },
      },
      async (span) => {
        try {
          await this.handle(event);
          await this.markDispatched(event);
          this.metrics.recordOutboxOutcome(event.event_type, 'processed');
          this.metrics.recordBusinessEvent(event.event_type);
          span.setStatus({ code: SpanStatusCode.OK });
          return true;
        } catch (error) {
          await this.markFailed(event, error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Outbox handler failed',
          });
          return false;
        } finally {
          span.end();
        }
      },
    );
  }

  private async handle(event: OutboxEventRow): Promise<void> {
    switch (event.event_type) {
      case 'payment.refund_requested':
        await this.payments.refundForSystem(event.aggregate_id, event.id);
        return;
      case 'notification.email':
        await this.notifications.deliverEmail(event.payload, event.id);
        return;
      case 'consultation.reminder_due':
        await this.notifications.deliverReminder(event.payload, event.id);
        return;
      default:
        // Domain events are fanned out to analytics/notification adapters. With
        // no external subscriber configured, successful persistence is enough.
        return;
    }
  }

  private async markDispatched(event: OutboxEventRow): Promise<void> {
    await this.database.query(
      `UPDATE outbox_events
          SET status = 'dispatched',
              dispatched_at = now(),
              locked_at = NULL,
              locked_by = NULL,
              last_error = NULL
        WHERE id = $1
          AND status = 'processing'`,
      [event.id],
    );
  }

  private async markFailed(event: OutboxEventRow, error: unknown): Promise<void> {
    const options = this.config.jobs.outbox;
    const terminal = event.attempts >= options.maxAttempts;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);

    if (terminal) {
      await this.database.query(
        `UPDATE outbox_events
            SET status = 'dead_letter',
                locked_at = NULL,
                locked_by = NULL,
                dispatched_at = NULL,
                last_error = $2
          WHERE id = $1
            AND status = 'processing'`,
        [event.id, message],
      );
      this.metrics.recordOutboxOutcome(event.event_type, 'dead_letter');
      this.logger.error(
        { eventId: event.id, eventType: event.event_type, attempts: event.attempts },
        'Outbox event moved to dead-letter queue',
      );
      return;
    }

    const delay = this.backoffDelay(event.attempts);
    await this.database.query(
      `UPDATE outbox_events
          SET status = 'pending',
              available_at = now() + ($2 * interval '1 millisecond'),
              locked_at = NULL,
              locked_by = NULL,
              last_error = $3
        WHERE id = $1
          AND status = 'processing'`,
      [event.id, delay, message],
    );
    this.metrics.recordOutboxOutcome(event.event_type, 'retried');
    this.logger.warn(
      {
        eventId: event.id,
        eventType: event.event_type,
        attempts: event.attempts,
        nextAttemptMs: delay,
      },
      'Outbox event scheduled for retry',
    );
  }

  private backoffDelay(attempts: number): number {
    const options = this.config.jobs.outbox;
    const exponential = Math.min(
      options.backoffMaxMs,
      options.backoffBaseMs * 2 ** Math.max(attempts - 1, 0),
    );
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.max(1, Math.round(exponential * jitter));
  }
}
