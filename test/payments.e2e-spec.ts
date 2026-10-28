import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import { generateTotpCode } from '../src/common/security/totp.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { AvailabilitySlot, DoctorSummary } from '../src/modules/doctors/doctors.types.js';
import type { Consultation } from '../src/modules/bookings/bookings.types.js';
import type {
  MessageResponse,
  Payment,
  PaymentIntentResponse,
  PaymentListResponse,
} from '../src/modules/payments/payments.types.js';
import { createTestApp } from './utils/create-test-app.js';

const DEMO_PASSWORD = 'DemoPass!2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET as string;
const RUN_ID = randomUUID().slice(0, 8);

interface ErrorResponse {
  error: { code: string; message: string };
}

interface WebhookPayload {
  eventId: string;
  eventType: 'payment.authorized' | 'payment.captured' | 'payment.failed' | 'payment.refunded';
  paymentId: string;
  providerReference: string;
  amount?: number;
  currency?: string;
  occurredAt: string;
}

function uniqueEmail(label: string): string {
  return `payment.${RUN_ID}.${label}.${randomUUID().slice(0, 8)}@example.test`;
}

function uniquePhone(): string {
  return `+9197${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

function key(label: string): string {
  return `payment-${RUN_ID}-${label}-${randomUUID()}`;
}

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

describe('Payments (e2e)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let patient: SessionResponse;
  let otherPatient: SessionResponse;
  let doctor: SessionResponse;
  let admin: SessionResponse;
  let doctorSummary: DoctorSummary;
  let consultation: Consultation;
  let payment: Payment;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);

    patient = await registerPatient('one');
    otherPatient = await registerPatient('two');
    doctor = await login('aarav.mehta@amrutam.local');
    admin = await login('admin@amrutam.local');

    const doctors = await app.inject({
      method: 'GET',
      url: '/api/v1/doctors?specialization=Cardiology&limit=1',
    });
    expect(doctors.statusCode, doctors.body).toBe(200);
    doctorSummary = doctors.json<{ data: DoctorSummary[] }>().data[0] as DoctorSummary;

    consultation = await bookConsultation(patient);
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerPatient(label: string): Promise<SessionResponse> {
    const email = uniqueEmail(label);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email,
        password: DEMO_PASSWORD,
        fullName: `Payment Patient ${label}`,
        phone: uniquePhone(),
        acceptedTerms: true,
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);

    return login(email);
  }

  async function login(email: string): Promise<SessionResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: DEMO_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<LoginResponse>();

    if (isSession(body)) {
      return body;
    }

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { mfaToken: body.mfaToken, code: generateTotpCode(DEMO_TOTP_SECRET) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json<SessionResponse>();
  }

  async function reserveSlot(): Promise<AvailabilitySlot> {
    const from = new Date();
    const to = new Date(from.getTime() + 45 * 86_400_000);
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/v1/doctors/${doctorSummary.id}/availability?` +
        new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          limit: '50',
        }).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const slot = response.json<{ data: AvailabilitySlot[] }>().data[0];

    if (!slot) {
      throw new Error('Expected an available slot');
    }

    return slot;
  }

  async function bookConsultation(session: SessionResponse): Promise<Consultation> {
    const slot = await reserveSlot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(session.accessToken, key('booking')),
      payload: { slotId: slot.id },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Consultation>();
  }

  function headers(token: string, idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
  }

  function signWebhook(rawBody: string): string {
    return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  }

  async function sendWebhook(provider: string, payload: WebhookPayload, signature?: string) {
    const rawBody = JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/payments/${provider}`,
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': signature ?? signWebhook(rawBody),
      },
      payload: rawBody,
    });
  }

  function webhookPayload(
    eventType: WebhookPayload['eventType'],
    target: Payment,
    eventId: string,
    overrides: Partial<WebhookPayload> = {},
  ): WebhookPayload {
    return {
      eventId,
      eventType,
      paymentId: target.id,
      providerReference: target.providerReference as string,
      amount: target.amount,
      currency: target.currency,
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('creates payment intents idempotently with server-derived amounts', async () => {
    const createKey = key('create');
    const body = {
      provider: 'mock' as const,
      returnUrl: 'https://app.amrutam.test/payments/return',
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken, createKey),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(201);
    const intent = response.json<PaymentIntentResponse>();
    payment = intent.payment;
    expect(payment).toMatchObject({
      consultationId: consultation.id,
      patientId: patient.user.id,
      status: 'pending',
      amount: consultation.fee.amountCents,
      amountRefunded: 0,
      currency: consultation.fee.currency,
      provider: 'mock',
    });
    expect(payment.providerReference).toMatch(/^mock_[0-9a-f]{32}$/);
    expect(intent.clientSecret).toBeNull();

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken, createKey),
      payload: body,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<PaymentIntentResponse>().payment.id).toBe(payment.id);

    const reusedKey = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken, createKey),
      payload: { provider: 'stripe' },
    });
    expect(reusedKey.statusCode).toBe(422);
    expect(reusedKey.json<ErrorResponse>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const duplicatePayment = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken, key('duplicate-payment')),
      payload: { provider: 'razorpay' },
    });
    expect(duplicatePayment.statusCode).toBe(409);
    expect(duplicatePayment.json<ErrorResponse>().error.code).toBe('PAYMENT_ALREADY_EXISTS');

    const otherPatientCreate = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(otherPatient.accessToken, key('other-patient-create')),
      payload: { provider: 'mock' },
    });
    expect(otherPatientCreate.statusCode).toBe(403);

    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken),
      payload: { provider: 'mock' },
    });
    expect(missingKey.statusCode).toBe(400);
  });

  it('confirms captures idempotently and enforces payment visibility', async () => {
    const confirmKey = key('confirm');
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: headers(patient.accessToken, confirmKey),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const captured = confirmed.json<Payment>();
    expect(captured.status).toBe('captured');
    expect(captured.authorizedAt).not.toBeNull();
    expect(captured.capturedAt).not.toBeNull();
    expect(captured.failureCode).toBeNull();

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: headers(patient.accessToken, confirmKey),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Payment>().status).toBe('captured');

    const newKeyConfirm = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: headers(patient.accessToken, key('second-confirm')),
    });
    expect(newKeyConfirm.statusCode, newKeyConfirm.body).toBe(200);
    expect(newKeyConfirm.json<Payment>().capturedAt).toBe(captured.capturedAt);

    const captureOutbox = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'payment.captured'`,
      [payment.id],
    );
    expect(captureOutbox.rows[0]?.count).toBe('1');

    const adminGet = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: headers(admin.accessToken),
    });
    expect(adminGet.statusCode, adminGet.body).toBe(200);

    const otherPatientGet = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${payment.id}`,
      headers: headers(otherPatient.accessToken),
    });
    expect(otherPatientGet.statusCode).toBe(403);

    const doctorList = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(doctor.accessToken),
    });
    expect(doctorList.statusCode).toBe(403);

    const patientList = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(patient.accessToken),
    });
    expect(patientList.statusCode, patientList.body).toBe(200);
    expect(patientList.json<PaymentListResponse>().data[0]?.status).toBe('captured');

    const otherPatientList = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings/${consultation.id}/payments`,
      headers: headers(otherPatient.accessToken),
    });
    expect(otherPatientList.statusCode).toBe(403);

    payment = captured;
  });

  it('supports partial and full admin refunds backed by an append-only ledger', async () => {
    const partialAmount = Math.min(100, Math.floor(payment.amount / 2));
    expect(partialAmount).toBeGreaterThan(0);

    const partialKey = key('partial-refund');
    const partial = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/refund`,
      headers: headers(admin.accessToken, partialKey),
      payload: { amount: partialAmount, reason: 'Patient requested partial refund' },
    });
    expect(partial.statusCode, partial.body).toBe(200);
    const partiallyRefunded = partial.json<Payment>();
    expect(partiallyRefunded.status).toBe('partially_refunded');
    expect(partiallyRefunded.amountRefunded).toBe(partialAmount);
    expect(partiallyRefunded.refundedAt).not.toBeNull();

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/refund`,
      headers: headers(admin.accessToken, partialKey),
      payload: { amount: partialAmount, reason: 'Patient requested partial refund' },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Payment>().amountRefunded).toBe(partialAmount);

    const remaining = payment.amount - partialAmount;
    const excessive = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/refund`,
      headers: headers(admin.accessToken, key('excessive-refund')),
      payload: { amount: remaining + 1, reason: 'Too much' },
    });
    expect(excessive.statusCode).toBe(422);
    expect(excessive.json<ErrorResponse>().error.code).toBe('PAYMENT_AMOUNT_EXCEEDS_BALANCE');

    const full = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/refund`,
      headers: headers(admin.accessToken, key('full-refund')),
      payload: { reason: 'Consultation cancelled' },
    });
    expect(full.statusCode, full.body).toBe(200);
    const refunded = full.json<Payment>();
    expect(refunded.status).toBe('refunded');
    expect(refunded.amountRefunded).toBe(payment.amount);

    const noBalance = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/refund`,
      headers: headers(admin.accessToken, key('no-balance-refund')),
      payload: { reason: 'Again' },
    });
    expect(noBalance.statusCode).toBe(422);
    expect(noBalance.json<ErrorResponse>().error.code).toBe('PAYMENT_NOT_REFUNDABLE');

    const confirmRefunded = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: headers(patient.accessToken, key('confirm-refunded')),
    });
    expect(confirmRefunded.statusCode).toBe(422);

    const ledger = await database.query<{ amount_cents: number }>(
      'SELECT amount_cents FROM payment_refunds WHERE payment_id = $1 ORDER BY created_at',
      [payment.id],
    );
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows.reduce((sum, row) => sum + row.amount_cents, 0)).toBe(payment.amount);
    await expect(
      database.query('UPDATE payment_refunds SET amount_cents = 1 WHERE payment_id = $1', [
        payment.id,
      ]),
    ).rejects.toThrow(/append-only/i);

    const refundAudit = await database.query<{ metadata_text: string }>(
      `SELECT metadata::text AS metadata_text FROM audit_logs
        WHERE resource_id = $1 AND action = 'payment.refunded'`,
      [payment.id],
    );
    expect(refundAudit.rows.length).toBeGreaterThanOrEqual(2);
    expect(refundAudit.rows[0]?.metadata_text).not.toContain('Patient requested partial refund');

    payment = refunded;
  });

  it('verifies webhook signatures, deduplicates events and reconciles state', async () => {
    const webhookConsultation = await bookConsultation(patient);
    const intentResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${webhookConsultation.id}/payments`,
      headers: headers(patient.accessToken, key('webhook-payment')),
      payload: { provider: 'mock' },
    });
    expect(intentResponse.statusCode, intentResponse.body).toBe(201);
    const webhookPayment = intentResponse.json<PaymentIntentResponse>().payment;

    const authorizedPayload = webhookPayload(
      'payment.authorized',
      webhookPayment,
      `evt-authorized-${RUN_ID}`,
    );
    const invalidSignatureResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payments/mock',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': '0'.repeat(64),
      },
      payload: JSON.stringify(authorizedPayload),
    });
    expect(invalidSignatureResponse.statusCode).toBe(401);
    expect(invalidSignatureResponse.json<ErrorResponse>().error.code).toBe(
      'INVALID_WEBHOOK_SIGNATURE',
    );

    const authorized = await sendWebhook('mock', authorizedPayload);
    expect(authorized.statusCode, authorized.body).toBe(200);
    expect(authorized.json<MessageResponse>().message).toBe('Event processed');

    const duplicate = await sendWebhook('mock', authorizedPayload);
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json<MessageResponse>().message).toBe('Event already processed');

    const authorizedPayment = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${webhookPayment.id}`,
      headers: headers(patient.accessToken),
    });
    expect(authorizedPayment.statusCode, authorizedPayment.body).toBe(200);
    expect(authorizedPayment.json<Payment>().status).toBe('authorized');

    const authorizedOutbox = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'payment.authorized'`,
      [webhookPayment.id],
    );
    expect(authorizedOutbox.rows[0]?.count).toBe('1');

    const capturedPayload = webhookPayload(
      'payment.captured',
      webhookPayment,
      `evt-captured-${RUN_ID}`,
    );
    const captured = await sendWebhook('mock', capturedPayload);
    expect(captured.statusCode, captured.body).toBe(200);
    expect(captured.json<MessageResponse>().message).toBe('Event processed');

    const lateFailure = await sendWebhook(
      'mock',
      webhookPayload('payment.failed', webhookPayment, `evt-late-failure-${RUN_ID}`),
    );
    expect(lateFailure.statusCode).toBe(422);

    const afterLateFailure = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${webhookPayment.id}`,
      headers: headers(patient.accessToken),
    });
    expect(afterLateFailure.json<Payment>().status).toBe('captured');

    const refundedPayload = webhookPayload(
      'payment.refunded',
      webhookPayment,
      `evt-refunded-${RUN_ID}`,
      { amount: webhookPayment.amount },
    );
    const refunded = await sendWebhook('mock', refundedPayload);
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json<MessageResponse>().message).toBe('Event processed');

    const duplicateRefund = await sendWebhook('mock', refundedPayload);
    expect(duplicateRefund.statusCode, duplicateRefund.body).toBe(200);
    expect(duplicateRefund.json<MessageResponse>().message).toBe('Event already processed');

    const afterRefund = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${webhookPayment.id}`,
      headers: headers(patient.accessToken),
    });
    expect(afterRefund.statusCode, afterRefund.body).toBe(200);
    expect(afterRefund.json<Payment>()).toMatchObject({
      status: 'refunded',
      amountRefunded: webhookPayment.amount,
    });

    const wrongProviderPayload = webhookPayload(
      'payment.authorized',
      webhookPayment,
      `evt-wrong-provider-${RUN_ID}`,
    );
    const wrongProvider = await sendWebhook('stripe', wrongProviderPayload);
    expect(wrongProvider.statusCode).toBe(422);
    const wrongProviderEvent = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payment_webhook_events
        WHERE provider = 'stripe' AND event_id = $1`,
      [wrongProviderPayload.eventId],
    );
    expect(wrongProviderEvent.rows[0]?.count).toBe('0');

    const eventRows = await database.query<{
      payload_sha256: string;
      event_type: string;
    }>(
      `SELECT payload_sha256, event_type FROM payment_webhook_events
        WHERE payment_id = $1 ORDER BY received_at`,
      [webhookPayment.id],
    );
    expect(eventRows.rows.map((row) => row.event_type)).toEqual([
      'payment.authorized',
      'payment.captured',
      'payment.refunded',
    ]);
    expect(eventRows.rows[0]?.payload_sha256).toBe(
      createHash('sha256').update(JSON.stringify(authorizedPayload)).digest('hex'),
    );

    const webhookAudit = await database.query<{ actor_id: string | null }>(
      `SELECT actor_id FROM audit_logs
        WHERE resource_id = $1 AND action IN ('payment.authorized', 'payment.captured', 'payment.refunded')`,
      [webhookPayment.id],
    );
    expect(webhookAudit.rows.length).toBe(3);
    expect(webhookAudit.rows.every((row) => row.actor_id === null)).toBe(true);
  });

  it('records failed payments and allows a fresh intent for the same consultation', async () => {
    const failedConsultation = await bookConsultation(patient);
    const firstIntent = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${failedConsultation.id}/payments`,
      headers: headers(patient.accessToken, key('failed-payment')),
      payload: { provider: 'mock' },
    });
    expect(firstIntent.statusCode, firstIntent.body).toBe(201);
    const failedPayment = firstIntent.json<PaymentIntentResponse>().payment;

    const failed = await sendWebhook(
      'mock',
      webhookPayload('payment.failed', failedPayment, `evt-failed-${RUN_ID}`),
    );
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json<MessageResponse>().message).toBe('Event processed');

    const failedGet = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/${failedPayment.id}`,
      headers: headers(patient.accessToken),
    });
    expect(failedGet.statusCode, failedGet.body).toBe(200);
    expect(failedGet.json<Payment>()).toMatchObject({
      status: 'failed',
      failureCode: 'provider_reported_failure',
    });

    const confirmFailed = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/${failedPayment.id}/confirm`,
      headers: headers(patient.accessToken, key('confirm-failed')),
    });
    expect(confirmFailed.statusCode).toBe(422);

    const retryIntent = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${failedConsultation.id}/payments`,
      headers: headers(patient.accessToken, key('retry-payment')),
      payload: { provider: 'mock' },
    });
    expect(retryIntent.statusCode, retryIntent.body).toBe(201);
    const retriedPayment = retryIntent.json<PaymentIntentResponse>().payment;
    expect(retriedPayment.id).not.toBe(failedPayment.id);
    expect(retriedPayment.status).toBe('pending');
  });
});
