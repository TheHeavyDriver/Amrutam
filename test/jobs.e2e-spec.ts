import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { AvailabilitySlot, DoctorSummary } from '../src/modules/doctors/doctors.types.js';
import type { Consultation } from '../src/modules/bookings/bookings.types.js';
import type { Payment, PaymentIntentResponse } from '../src/modules/payments/payments.types.js';
import { OutboxDispatcherService } from '../src/modules/jobs/outbox-dispatcher.service.js';
import { ScheduledJobsService } from '../src/modules/jobs/scheduled-jobs.service.js';
import { createTestApp } from './utils/create-test-app.js';

const DEMO_PASSWORD = 'DemoPass!2026';

function headers(token: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

describe('Outbox worker and scheduled jobs (e2e)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let dispatcher: OutboxDispatcherService;
  let scheduler: ScheduledJobsService;
  let patient: SessionResponse;
  let doctorSummary: DoctorSummary;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    dispatcher = app.get(OutboxDispatcherService);
    scheduler = app.get(ScheduledJobsService);
    patient = await login('patient1@amrutam.local');

    const doctors = await app.inject({
      method: 'GET',
      url: '/api/v1/doctors?specialization=Cardiology&limit=1',
    });
    expect(doctors.statusCode, doctors.body).toBe(200);
    doctorSummary = doctors.json<{ data: DoctorSummary[] }>().data[0] as DoctorSummary;
  });

  afterAll(async () => {
    await dispatcher.stop();
    await scheduler.stop();
    await app.close();
  });

  async function login(email: string): Promise<SessionResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: DEMO_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<LoginResponse>() as SessionResponse;
  }

  async function bookConsultation(): Promise<Consultation> {
    const from = new Date();
    const to = new Date(from.getTime() + 45 * 86_400_000);
    const availability = await app.inject({
      method: 'GET',
      url:
        `/api/v1/doctors/${doctorSummary.id}/availability?` +
        new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          limit: '50',
        }).toString(),
    });
    expect(availability.statusCode, availability.body).toBe(200);
    const slot = availability.json<{ data: AvailabilitySlot[] }>().data[0];

    if (!slot) {
      throw new Error('Expected an available slot');
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(patient.accessToken, `jobs-booking-${randomUUID()}`),
      payload: { slotId: slot.id },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Consultation>();
  }

  it('exposes Prometheus metrics and records request/outbox telemetry', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('amrutam_http_requests_total');
    expect(response.body).toContain('amrutam_http_request_duration_seconds');
    expect(response.body).toContain('amrutam_outbox_backlog');
    expect(response.body).toContain('amrutam_process_cpu_seconds_total');
  });

  it('compensates a captured payment asynchronously when a consultation is cancelled', async () => {
    const consultation = await bookConsultation();
    const intentResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken, `jobs-payment-${randomUUID()}`),
      payload: { provider: 'mock' },
    });
    expect(intentResponse.statusCode, intentResponse.body).toBe(201);
    const payment = intentResponse.json<PaymentIntentResponse>().payment;

    const capturedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: headers(patient.accessToken, `jobs-confirm-${randomUUID()}`),
    });
    expect(capturedResponse.statusCode, capturedResponse.body).toBe(200);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/cancel`,
      headers: headers(patient.accessToken, `jobs-cancel-${randomUUID()}`),
      payload: { reason: 'Patient cannot attend' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const requested = await database.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'payment.refund_requested'`,
      [payment.id],
    );
    expect(requested.rows[0]?.status).toBe('pending');

    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: headers(patient.accessToken),
    });
    expect(before.json<Payment>().status).toBe('captured');

    for (let batch = 0; batch < 50; batch += 1) {
      const processed = await dispatcher.processAvailableEvents();
      if (processed === 0) {
        break;
      }
    }

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: headers(patient.accessToken),
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json<Payment>()).toMatchObject({
      status: 'refunded',
      amountRefunded: payment.amount,
    });

    const ledger = await database.query<{ reason: string; provider_reference: string }>(
      `SELECT reason, provider_reference FROM payment_refunds WHERE payment_id = $1`,
      [payment.id],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]?.reason).toBe('Consultation cancellation compensation');
    expect(ledger.rows[0]?.provider_reference).toMatch(/^system:/);

    const audit = await database.query<{ metadata_text: string }>(
      `SELECT metadata::text AS metadata_text FROM audit_logs
        WHERE resource_id = $1 AND action = 'payment.refunded'`,
      [payment.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata_text).toContain('cancellation_compensation');

    const dispatched = await database.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events WHERE aggregate_id = $1`,
      [payment.id],
    );
    expect(dispatched.rows.every((row) => row.status === 'dispatched')).toBe(true);

    await dispatcher.processAvailableEvents();
    const duplicateLedger = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payment_refunds WHERE payment_id = $1`,
      [payment.id],
    );
    expect(duplicateLedger.rows[0]?.count).toBe('1');
  });

  it('marks overdue consultations no-show and enqueues deduplicated reminders', async () => {
    const noShowConsultation = await bookConsultation();
    await database.query(
      `UPDATE consultations
          SET scheduled_start = now() - interval '40 minutes',
              scheduled_end = now() - interval '20 minutes'
        WHERE id = $1`,
      [noShowConsultation.id],
    );

    const reminderConsultation = await bookConsultation();
    await database.query(
      `UPDATE consultations
          SET scheduled_start = now() + interval '30 minutes',
              scheduled_end = now() + interval '55 minutes'
        WHERE id = $1`,
      [reminderConsultation.id],
    );

    await scheduler.runOnce();

    const noShow = await database.query<{ status: string; no_show_at: Date | null }>(
      `SELECT status::text AS status, no_show_at FROM consultations WHERE id = $1`,
      [noShowConsultation.id],
    );
    expect(noShow.rows[0]?.status).toBe('no_show');
    expect(noShow.rows[0]?.no_show_at).not.toBeNull();

    const releasedSlot = await database.query<{ status: string; claim_count: string }>(
      `SELECT slot.status::text AS status,
              (SELECT count(*)::text
                 FROM consultation_slot_claims claim
                WHERE claim.consultation_id = $1) AS claim_count
         FROM availability_slots slot
        WHERE slot.id = $2`,
      [noShowConsultation.id, noShowConsultation.slotId],
    );
    expect(releasedSlot.rows[0]?.status).toBe('available');
    expect(releasedSlot.rows[0]?.claim_count).toBe('0');

    const noShowAudit = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE resource_id = $1 AND action = 'consultation.no_show'`,
      [noShowConsultation.id],
    );
    expect(noShowAudit.rows[0]?.count).toBe('1');

    const reminders = await database.query<{ reminder_type: string }>(
      `SELECT reminder_type FROM consultation_reminders WHERE consultation_id = $1`,
      [reminderConsultation.id],
    );
    expect(reminders.rows.map((row) => row.reminder_type)).toContain('1h');

    const reminderEvents = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'consultation.reminder_due'`,
      [reminderConsultation.id],
    );
    expect(Number(reminderEvents.rows[0]?.count)).toBeGreaterThanOrEqual(1);

    await scheduler.runOnce();
    const duplicateReminderEvents = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'consultation.reminder_due'`,
      [reminderConsultation.id],
    );
    expect(duplicateReminderEvents.rows[0]?.count).toBe(reminderEvents.rows[0]?.count);

    await dispatcher.processAvailableEvents();
    const dispatchedReminders = await database.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'consultation.reminder_due'`,
      [reminderConsultation.id],
    );
    expect(dispatchedReminders.rows.every((row) => row.status === 'dispatched')).toBe(true);
  });

  it('retries poisoned outbox events with backoff and parks them in the DLQ', async () => {
    const inserted = await database.query<{ id: string; attempts: number }>(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, payload
       ) VALUES ('user', $1, 'notification.email', '{}'::jsonb)
       RETURNING id, attempts`,
      [randomUUID()],
    );
    const eventId = inserted.rows[0]?.id as string;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await database.query(
        `UPDATE outbox_events
            SET available_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [eventId],
      );
      await dispatcher.processAvailableEvents();
    }

    const deadLetter = await database.query<{
      status: string;
      attempts: number;
      last_error: string;
      dispatched_at: Date | null;
    }>(
      `SELECT status::text AS status, attempts, last_error, dispatched_at
         FROM outbox_events WHERE id = $1`,
      [eventId],
    );
    expect(deadLetter.rows[0]?.status).toBe('dead_letter');
    expect(deadLetter.rows[0]?.attempts).toBe(10);
    expect(deadLetter.rows[0]?.last_error).toContain('Malformed notification.email payload');
    expect(deadLetter.rows[0]?.dispatched_at).toBeNull();

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('event_type="notification.email",outcome="dead_letter"');
  });
});
