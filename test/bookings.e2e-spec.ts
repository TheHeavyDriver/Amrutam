import { randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '../src/common/security/totp.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import type { AvailabilitySlot, DoctorSummary } from '../src/modules/doctors/doctors.types.js';
import type {
  Consultation,
  ConsultationListResponse,
  JoinTokenResponse,
} from '../src/modules/bookings/bookings.types.js';
import { createTestApp } from './utils/create-test-app.js';

const DEMO_PASSWORD = 'DemoPass!2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const RUN_ID = randomUUID().slice(0, 8);

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

interface PatientSession {
  session: SessionResponse;
  email: string;
}

function uniqueEmail(label: string): string {
  return `booking.${RUN_ID}.${label}.${randomUUID().slice(0, 8)}@example.test`;
}

function uniquePhone(): string {
  return `+9197${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

function key(label: string): string {
  return `booking-${RUN_ID}-${label}-${randomUUID()}`;
}

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

describe('Booking and consultation lifecycle (e2e)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let patientOne: PatientSession;
  let patientTwo: PatientSession;
  let doctorSession: SessionResponse;
  let adminSession: SessionResponse;
  let doctor: DoctorSummary;
  let otherDoctor: DoctorSummary;
  let primaryConsultation: Consultation;
  let rescheduledConsultation: Consultation;
  let joinConsultation: Consultation;
  const usedSlotIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);

    patientOne = await registerPatient('one');
    patientTwo = await registerPatient('two');
    doctorSession = await login('aarav.mehta@amrutam.local');
    adminSession = await login('admin@amrutam.local');

    const cardiologists = await listDoctors('specialization=Cardiology&limit=1');
    doctor = cardiologists.data[0] as DoctorSummary;
    expect(doctor.id).toBeTruthy();

    const dermatologists = await listDoctors('specialization=Dermatology&limit=1');
    otherDoctor = dermatologists.data[0] as DoctorSummary;
    expect(otherDoctor.id).toBeTruthy();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerPatient(label: string): Promise<PatientSession> {
    const email = uniqueEmail(label);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email,
        password: DEMO_PASSWORD,
        fullName: `Booking Patient ${label}`,
        phone: uniquePhone(),
        acceptedTerms: true,
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);

    const session = await login(email);
    return { session, email };
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

  async function listDoctors(query: string): Promise<{
    data: DoctorSummary[];
  }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors?${query}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ data: DoctorSummary[] }>();
  }

  async function reserveSlot(doctorId = doctor.id): Promise<AvailabilitySlot> {
    const from = new Date();
    const to = new Date(from.getTime() + 30 * 86_400_000);
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/v1/doctors/${doctorId}/availability?` +
        new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          limit: '50',
        }).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ data: AvailabilitySlot[] }>();
    const slot = body.data.find((candidate) => !usedSlotIds.has(candidate.id));

    if (!slot) {
      throw new Error('Expected an unused available slot');
    }

    usedSlotIds.add(slot.id);
    return slot;
  }

  function headers(token: string, idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
  }

  async function createBooking(
    session: SessionResponse,
    slotId: string,
    idempotencyKey = key('create'),
  ): Promise<Consultation> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(session.accessToken, idempotencyKey),
      payload: { slotId, notes: 'Please call before the consultation.' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Consultation>();
  }

  async function countRows(sql: string, values: unknown[] = []): Promise<number> {
    const result = await database.query<{ count: number }>(sql, values);
    return result.rows[0]?.count ?? 0;
  }

  it('creates a booking idempotently, rejects key reuse, and reserves the slot', async () => {
    const slot = await reserveSlot();
    const idempotencyKey = key('idempotent-create');
    primaryConsultation = await createBooking(patientOne.session, slot.id, idempotencyKey);

    expect(primaryConsultation).toMatchObject({
      patientId: patientOne.session.user.id,
      doctorId: doctor.id,
      slotId: slot.id,
      status: 'scheduled',
      fee: { amountCents: doctor.consultationFee.amountCents, currency: 'INR' },
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(patientOne.session.accessToken, idempotencyKey),
      payload: { slotId: slot.id, notes: 'Please call before the consultation.' },
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Consultation>().id).toBe(primaryConsultation.id);

    const differentSlot = await reserveSlot();
    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(patientOne.session.accessToken, idempotencyKey),
      payload: { slotId: differentSlot.id },
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json<ErrorResponse>().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(patientOne.session.accessToken),
      payload: { slotId: differentSlot.id },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');

    const badKey = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: headers(patientOne.session.accessToken, 'short'),
      payload: { slotId: differentSlot.id },
    });
    expect(badKey.statusCode).toBe(400);

    expect(
      await countRows(
        `SELECT count(*)::int AS count FROM consultations
          WHERE slot_id = $1 AND status IN ('scheduled', 'in_progress')`,
        [slot.id],
      ),
    ).toBe(1);
    expect(
      await countRows(
        `SELECT count(*)::int AS count FROM consultation_slot_claims
          WHERE slot_id = $1`,
        [slot.id],
      ),
    ).toBe(1);
    const slotRow = await database.query<{ status: string }>(
      'SELECT status FROM availability_slots WHERE id = $1',
      [slot.id],
    );
    expect(slotRow.rows[0]?.status).toBe('booked');

    expect(
      await countRows(
        `SELECT count(*)::int AS count FROM outbox_events
          WHERE aggregate_id = $1 AND event_type = 'consultation.booked'`,
        [primaryConsultation.id],
      ),
    ).toBe(1);
  });

  it('allocates a contested slot to exactly one concurrent booking', async () => {
    const slot = await reserveSlot();
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/bookings',
        headers: headers(patientOne.session.accessToken, key('race-one')),
        payload: { slotId: slot.id },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/bookings',
        headers: headers(patientTwo.session.accessToken, key('race-two')),
        payload: { slotId: slot.id },
      }),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((left, right) => left - right);
    expect(statuses).toEqual([201, 409]);

    const conflict = first.statusCode === 409 ? first : second;
    expect(conflict.json<ErrorResponse>().error.code).toBe('SLOT_UNAVAILABLE');

    expect(
      await countRows(
        `SELECT count(*)::int AS count FROM consultations
          WHERE slot_id = $1 AND status IN ('scheduled', 'in_progress')`,
        [slot.id],
      ),
    ).toBe(1);
    expect(
      await countRows(
        `SELECT count(*)::int AS count FROM consultation_slot_claims
          WHERE slot_id = $1`,
        [slot.id],
      ),
    ).toBe(1);
  });

  it('enforces consultation visibility and role boundaries', async () => {
    const url = `/api/v1/bookings/${primaryConsultation.id}`;

    const anonymous = await app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);

    const otherPatient = await app.inject({
      method: 'GET',
      url,
      headers: headers(patientTwo.session.accessToken),
    });
    expect(otherPatient.statusCode).toBe(403);

    const admin = await app.inject({
      method: 'GET',
      url,
      headers: headers(adminSession.accessToken),
    });
    expect(admin.statusCode, admin.body).toBe(200);

    const patientCancel = await app.inject({
      method: 'POST',
      url: `${url}/cancel`,
      headers: headers(patientTwo.session.accessToken, key('unauthorized-cancel')),
      payload: { reason: 'Not my consultation' },
    });
    expect(patientCancel.statusCode).toBe(403);

    const doctorCancel = await app.inject({
      method: 'POST',
      url: `${url}/cancel`,
      headers: headers(doctorSession.accessToken, key('doctor-cancel')),
      payload: { reason: 'Doctors cannot cancel here' },
    });
    expect(doctorCancel.statusCode).toBe(403);

    const patientStart = await app.inject({
      method: 'POST',
      url: `${url}/start`,
      headers: headers(patientOne.session.accessToken, key('patient-start')),
    });
    expect(patientStart.statusCode).toBe(403);
  });

  it('cancels idempotently, releases the slot, and rejects terminal transitions', async () => {
    const cancelKey = key('cancel');
    const cancellation = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${primaryConsultation.id}/cancel`,
      headers: headers(patientOne.session.accessToken, cancelKey),
      payload: { reason: 'Schedule changed' },
    });
    expect(cancellation.statusCode, cancellation.body).toBe(200);
    const cancelled = cancellation.json<Consultation>();
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Schedule changed',
    });
    expect(cancelled.cancelledAt).not.toBeNull();

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${primaryConsultation.id}/cancel`,
      headers: headers(patientOne.session.accessToken, cancelKey),
      payload: { reason: 'Schedule changed' },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<Consultation>().cancelledAt).toBe(cancelled.cancelledAt);

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${primaryConsultation.id}/cancel`,
      headers: headers(patientOne.session.accessToken, key('cancel-again')),
      payload: { reason: 'Already cancelled' },
    });
    expect(repeated.statusCode).toBe(422);
    expect(repeated.json<ErrorResponse>().error.code).toBe('INVALID_STATE_TRANSITION');

    const slot = await database.query<{ status: string }>(
      'SELECT status FROM availability_slots WHERE id = $1',
      [primaryConsultation.slotId],
    );
    expect(slot.rows[0]?.status).toBe('available');
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM consultation_slot_claims WHERE consultation_id = $1',
        [primaryConsultation.id],
      ),
    ).toBe(0);
  });

  it('reschedules transactionally and rejects a doctor change', async () => {
    const initialSlot = await reserveSlot();
    const newSlot = await reserveSlot();
    rescheduledConsultation = await createBooking(
      patientTwo.session,
      initialSlot.id,
      key('reschedule-create'),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/reschedule`,
      headers: headers(patientTwo.session.accessToken, key('reschedule')),
      payload: { slotId: newSlot.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    const moved = response.json<Consultation>();
    expect(moved.slotId).toBe(newSlot.id);
    expect(moved.scheduledStart).toBe(newSlot.startsAt);
    expect(moved.status).toBe('scheduled');

    const oldSlot = await database.query<{ status: string }>(
      'SELECT status FROM availability_slots WHERE id = $1',
      [initialSlot.id],
    );
    expect(oldSlot.rows[0]?.status).toBe('available');
    const claimedSlot = await database.query<{ status: string }>(
      'SELECT status FROM availability_slots WHERE id = $1',
      [newSlot.id],
    );
    expect(claimedSlot.rows[0]?.status).toBe('booked');

    const claim = await database.query<{ slot_id: string }>(
      'SELECT slot_id FROM consultation_slot_claims WHERE consultation_id = $1',
      [rescheduledConsultation.id],
    );
    expect(claim.rows[0]?.slot_id).toBe(newSlot.id);

    const otherDoctorSlot = await reserveSlot(otherDoctor.id);
    const wrongDoctor = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/reschedule`,
      headers: headers(patientTwo.session.accessToken, key('reschedule-wrong-doctor')),
      payload: { slotId: otherDoctorSlot.id },
    });
    expect(wrongDoctor.statusCode).toBe(422);
    expect(wrongDoctor.json<ErrorResponse>().error.code).toBe('UNPROCESSABLE_ENTITY');

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${primaryConsultation.id}/reschedule`,
      headers: headers(patientOne.session.accessToken, key('reschedule-cancelled')),
      payload: { slotId: (await reserveSlot()).id },
    });
    expect(cancelled.statusCode).toBe(422);
    expect(cancelled.json<ErrorResponse>().error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('runs start/complete transitions and keeps clinical text out of audit and outbox metadata', async () => {
    const startKey = key('start');
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/start`,
      headers: headers(doctorSession.accessToken, startKey),
    });
    expect(started.statusCode, started.body).toBe(200);
    const inProgress = started.json<Consultation>();
    expect(inProgress.status).toBe('in_progress');
    expect(inProgress.startedAt).not.toBeNull();

    const startReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/start`,
      headers: headers(doctorSession.accessToken, startKey),
    });
    expect(startReplay.statusCode, startReplay.body).toBe(200);
    expect(startReplay.headers['idempotency-replayed']).toBe('true');

    const secondStart = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/start`,
      headers: headers(doctorSession.accessToken, key('start-again')),
    });
    expect(secondStart.statusCode).toBe(422);
    expect(secondStart.json<ErrorResponse>().error.code).toBe('INVALID_STATE_TRANSITION');

    const diagnosis = `Private diagnosis ${randomUUID()}`;
    const completeKey = key('complete');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/complete`,
      headers: headers(doctorSession.accessToken, completeKey),
      payload: { diagnosis, notes: 'Private clinical notes' },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const body = completed.json<Consultation>();
    expect(body.status).toBe('completed');
    expect(body.endedAt).not.toBeNull();
    expect(body.diagnosis).toBe(diagnosis);

    const completeReplay = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/complete`,
      headers: headers(doctorSession.accessToken, completeKey),
      payload: { diagnosis, notes: 'Private clinical notes' },
    });
    expect(completeReplay.statusCode, completeReplay.body).toBe(200);
    expect(completeReplay.headers['idempotency-replayed']).toBe('true');

    const audit = await database.query<{ metadata_text: string }>(
      `SELECT metadata::text AS metadata_text
         FROM audit_logs
        WHERE resource_id = $1 AND action = 'consultation.completed'`,
      [rescheduledConsultation.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata_text).not.toContain(diagnosis);
    expect(audit.rows[0]?.metadata_text).not.toContain('Private clinical notes');

    const outbox = await database.query<{ payload_text: string }>(
      `SELECT payload::text AS payload_text
         FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'consultation.completed'`,
      [rescheduledConsultation.id],
    );
    expect(outbox.rows[0]?.payload_text).not.toContain(diagnosis);

    const joinAfterCompletion = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${rescheduledConsultation.id}/join-token`,
      headers: headers(patientTwo.session.accessToken),
    });
    expect(joinAfterCompletion.statusCode).toBe(409);
    expect(joinAfterCompletion.json<ErrorResponse>().error.code).toBe('JOIN_TOKEN_UNAVAILABLE');
  });

  it('marks a no-show, releases the slot, and records the transition', async () => {
    const slot = await reserveSlot();
    const consultation = await createBooking(patientOne.session, slot.id, key('noshow-create'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${consultation.id}/no-show`,
      headers: headers(doctorSession.accessToken, key('noshow')),
      payload: { notes: 'Patient did not join' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const marked = response.json<Consultation>();
    expect(marked.status).toBe('no_show');
    expect(marked.noShowAt).not.toBeNull();

    const slotRow = await database.query<{ status: string }>(
      'SELECT status FROM availability_slots WHERE id = $1',
      [slot.id],
    );
    expect(slotRow.rows[0]?.status).toBe('available');
    expect(
      await countRows(
        'SELECT count(*)::int AS count FROM consultation_slot_claims WHERE consultation_id = $1',
        [consultation.id],
      ),
    ).toBe(0);

    const audit = await database.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE resource_id = $1 AND action = 'consultation.no_show'`,
      [consultation.id],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('issues short-lived join tokens and stores only keyed hashes', async () => {
    const slot = await reserveSlot();
    joinConsultation = await createBooking(patientOne.session, slot.id, key('join-create'));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${joinConsultation.id}/join-token`,
      headers: headers(patientOne.session.accessToken),
    });
    expect(response.statusCode, response.body).toBe(200);
    const first = response.json<JoinTokenResponse>();
    expect(first.token.length).toBeGreaterThan(30);
    expect(first.joinUrl).toContain(first.token);
    expect(first.joinUrl).toContain(joinConsultation.id);
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(first.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 11 * 60_000);

    const stored = await database.query<{
      join_token_hash: string | null;
      join_token_expires_at: Date | null;
    }>('SELECT join_token_hash, join_token_expires_at FROM consultations WHERE id = $1', [
      joinConsultation.id,
    ]);
    expect(stored.rows[0]?.join_token_hash).not.toBe(first.token);
    expect(stored.rows[0]?.join_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.join_token_expires_at).not.toBeNull();

    const otherPatient = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${joinConsultation.id}/join-token`,
      headers: headers(patientTwo.session.accessToken),
    });
    expect(otherPatient.statusCode).toBe(403);

    const admin = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${joinConsultation.id}/join-token`,
      headers: headers(adminSession.accessToken),
    });
    expect(admin.statusCode).toBe(403);

    const doctorToken = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${joinConsultation.id}/join-token`,
      headers: headers(doctorSession.accessToken),
    });
    expect(doctorToken.statusCode, doctorToken.body).toBe(200);
    expect(doctorToken.json<JoinTokenResponse>().token).not.toBe(first.token);
  });

  it('lists consultations per role with status filters and stable cursors', async () => {
    const patientList = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings?limit=50',
      headers: headers(patientOne.session.accessToken),
    });
    expect(patientList.statusCode, patientList.body).toBe(200);
    const patientBody = patientList.json<ConsultationListResponse>();
    expect(patientBody.data.length).toBeGreaterThanOrEqual(3);
    expect(patientBody.data.every((item) => item.patientId === patientOne.session.user.id)).toBe(
      true,
    );

    const cancelled = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings?status=cancelled&limit=50',
      headers: headers(patientOne.session.accessToken),
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(
      cancelled
        .json<ConsultationListResponse>()
        .data.every(
          (item) => item.status === 'cancelled' && item.patientId === patientOne.session.user.id,
        ),
    ).toBe(true);

    const doctorList = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings?limit=50',
      headers: headers(doctorSession.accessToken),
    });
    expect(doctorList.statusCode, doctorList.body).toBe(200);
    expect(
      doctorList.json<ConsultationListResponse>().data.every((item) => item.doctorId === doctor.id),
    ).toBe(true);

    const adminFirst = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings?limit=2',
      headers: headers(adminSession.accessToken),
    });
    expect(adminFirst.statusCode, adminFirst.body).toBe(200);
    const firstPage = adminFirst.json<ConsultationListResponse>();
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).toBeTruthy();

    const adminSecond = await app.inject({
      method: 'GET',
      url: `/api/v1/bookings?limit=2&cursor=${encodeURIComponent(
        firstPage.page.nextCursor as string,
      )}`,
      headers: headers(adminSession.accessToken),
    });
    expect(adminSecond.statusCode, adminSecond.body).toBe(200);
    const secondPage = adminSecond.json<ConsultationListResponse>();
    expect(
      secondPage.data.some((item) => firstPage.data.some((first) => first.id === item.id)),
    ).toBe(false);
    expect(new Date(secondPage.data[0]?.scheduledStart as string).getTime()).toBeLessThanOrEqual(
      new Date(firstPage.data[1]?.scheduledStart as string).getTime(),
    );

    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/api/v1/bookings?cursor=not-a-cursor',
      headers: headers(adminSession.accessToken),
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json<ErrorResponse>().error.message).toBe('Invalid cursor');
  });
});
