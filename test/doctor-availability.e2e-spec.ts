import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '../src/common/security/totp.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import type { Consultation } from '../src/modules/bookings/bookings.types.js';
import type {
  AvailabilityListResponse,
  AvailabilitySlot,
} from '../src/modules/doctors/doctors.types.js';
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

function key(label: string): string {
  return `availability-${RUN_ID}-${label}-${randomUUID()}`;
}

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

describe('Doctor availability management (e2e)', () => {
  let app: NestFastifyApplication;
  let doctor: SessionResponse;
  let patient: SessionResponse;

  beforeAll(async () => {
    app = await createTestApp();
    doctor = await login('aarav.mehta@amrutam.local');
    patient = await login('patient1@amrutam.local');
  });

  afterAll(async () => {
    await app.close();
  });

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

  function futureSlot(dayOffset: number, minute = 0): { startsAt: Date; endsAt: Date } {
    const startsAt = new Date(Date.now() + dayOffset * 86_400_000);
    startsAt.setUTCSeconds(0, 0);
    startsAt.setUTCMinutes(minute);
    return { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) };
  }

  function authHeaders(session: SessionResponse, idempotencyKey?: string): Record<string, string> {
    return {
      authorization: `Bearer ${session.accessToken}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
  }

  async function createSlot(
    session: SessionResponse,
    startsAt: Date,
    endsAt: Date,
    idempotencyKey = key('create'),
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/doctors/me/availability',
      headers: authHeaders(session, idempotencyKey),
      payload: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    });
  }

  async function ownAvailability(
    session: SessionResponse,
    startsAt: Date,
    endsAt: Date,
  ): Promise<AvailabilityListResponse> {
    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v1/doctors/me/availability?' +
        new URLSearchParams({
          from: new Date(startsAt.getTime() - 3_600_000).toISOString(),
          to: new Date(endsAt.getTime() + 3_600_000).toISOString(),
          limit: '50',
        }).toString(),
      headers: authHeaders(session),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AvailabilityListResponse>();
  }

  async function publicAvailability(
    startsAt: Date,
    endsAt: Date,
  ): Promise<AvailabilityListResponse> {
    const response = await app.inject({
      method: 'GET',
      url:
        `/api/v1/doctors/${doctor.user.id}/availability?` +
        new URLSearchParams({
          from: new Date(startsAt.getTime() - 3_600_000).toISOString(),
          to: new Date(endsAt.getTime() + 3_600_000).toISOString(),
          limit: '50',
        }).toString(),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AvailabilityListResponse>();
  }

  it('creates, lists, replays, and removes an available slot', async () => {
    const { startsAt, endsAt } = futureSlot(300);
    const idempotencyKey = key('lifecycle');

    const created = await createSlot(doctor, startsAt, endsAt, idempotencyKey);
    expect(created.statusCode, created.body).toBe(201);
    const slot = created.json<AvailabilitySlot>();
    expect(slot).toMatchObject({
      doctorId: doctor.user.id,
      status: 'available',
      durationMinutes: 30,
    });

    const replayed = await createSlot(doctor, startsAt, endsAt, idempotencyKey);
    expect(replayed.statusCode, replayed.body).toBe(201);
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    expect(replayed.json<AvailabilitySlot>().id).toBe(slot.id);

    const audit = await app.get(DatabaseService).query<{
      actor_id: string;
      action: string;
    }>(
      `SELECT actor_id, action
         FROM audit_logs
        WHERE resource_type = 'availability_slot'
          AND resource_id = $1
        ORDER BY occurred_at ASC`,
      [slot.id],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ actor_id: doctor.user.id, action: 'doctor.availability_created' }),
    ]);

    const own = await ownAvailability(doctor, startsAt, endsAt);
    expect(own.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: slot.id })]));

    const publicSlots = await publicAvailability(startsAt, endsAt);
    expect(publicSlots.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: slot.id, status: 'available' })]),
    );

    const deleteKey = key('delete');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/doctors/me/availability/${slot.id}`,
      headers: authHeaders(doctor, deleteKey),
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const deleteAudit = await app.get(DatabaseService).query<{
      actor_id: string;
      action: string;
    }>(
      `SELECT actor_id, action
         FROM audit_logs
        WHERE resource_type = 'availability_slot'
          AND resource_id = $1
          AND action = 'doctor.availability_deleted'`,
      [slot.id],
    );
    expect(deleteAudit.rows).toEqual([
      expect.objectContaining({ actor_id: doctor.user.id, action: 'doctor.availability_deleted' }),
    ]);

    const replayedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/doctors/me/availability/${slot.id}`,
      headers: authHeaders(doctor, deleteKey),
    });
    expect(replayedDelete.statusCode, replayedDelete.body).toBe(204);
    expect(replayedDelete.headers['idempotency-replayed']).toBe('true');

    const afterDelete = await publicAvailability(startsAt, endsAt);
    expect(afterDelete.data.some((entry) => entry.id === slot.id)).toBe(false);
  });

  it('rejects overlapping, past, and too-short slots', async () => {
    const { startsAt, endsAt } = futureSlot(301, 15);
    const created = await createSlot(doctor, startsAt, endsAt);
    expect(created.statusCode, created.body).toBe(201);

    const overlapping = await createSlot(
      doctor,
      new Date(startsAt.getTime() + 10 * 60_000),
      new Date(endsAt.getTime() + 10 * 60_000),
    );
    expect(overlapping.statusCode, overlapping.body).toBe(409);
    expect(overlapping.json<ErrorResponse>().error.code).toBe('SLOT_UNAVAILABLE');

    const past = await createSlot(
      doctor,
      new Date(Date.now() - 60 * 60_000),
      new Date(Date.now() - 30 * 60_000),
    );
    expect(past.statusCode, past.body).toBe(400);
    expect(past.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');

    const tooShort = await createSlot(
      doctor,
      new Date(startsAt.getTime() + 120 * 60_000),
      new Date(startsAt.getTime() + 122 * 60_000),
    );
    expect(tooShort.statusCode, tooShort.body).toBe(400);
    expect(tooShort.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });

  it('enforces the doctor role and prevents deleting a booked slot', async () => {
    const { startsAt, endsAt } = futureSlot(302, 30);
    const created = await createSlot(doctor, startsAt, endsAt);
    expect(created.statusCode, created.body).toBe(201);
    const slot = created.json<AvailabilitySlot>();

    const forbidden = await createSlot(patient, startsAt, endsAt);
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect(forbidden.json<ErrorResponse>().error.code).toBe('FORBIDDEN');

    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/doctors/me/availability',
      headers: { 'idempotency-key': key('unauthenticated') },
      payload: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    });
    expect(unauthenticated.statusCode, unauthenticated.body).toBe(401);

    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: authHeaders(patient, key('booking')),
      payload: { slotId: slot.id },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    expect(booked.json<Consultation>().slotId).toBe(slot.id);

    const removeBooked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/doctors/me/availability/${slot.id}`,
      headers: authHeaders(doctor, key('remove-booked')),
    });
    expect(removeBooked.statusCode, removeBooked.body).toBe(409);
    expect(removeBooked.json<ErrorResponse>().error.code).toBe('SLOT_UNAVAILABLE');
  });
});
