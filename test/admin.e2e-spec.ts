import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '../src/common/security/totp.js';
import { DatabaseService } from '../src/database/database.service.js';
import type {
  DoctorDetail,
  DoctorDetailListResponse,
} from '../src/modules/doctors/doctors.types.js';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import { createTestApp } from './utils/create-test-app.js';

const DEMO_PASSWORD = 'DemoPass!2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const TARGET_DOCTOR_EMAIL = 'ananya.bose@amrutam.local';
const REVIEW_REASON = 'Routine compliance review';

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

function headers(token?: string, idempotencyKey?: string): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

describe('Admin doctor administration (e2e)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let admin: SessionResponse;
  let doctor: SessionResponse;
  let target: DoctorDetail;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    admin = await login('admin@amrutam.local');
    doctor = await login(TARGET_DOCTOR_EMAIL);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?limit=100',
      headers: headers(admin.accessToken),
    });
    expect(response.statusCode, response.body).toBe(200);
    const listed = response
      .json<DoctorDetailListResponse>()
      .data.find((candidate) => candidate.specialization === 'Psychiatry');

    if (!listed) {
      throw new Error('Expected a seeded psychiatry doctor');
    }

    target = listed;
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

  it('requires an admin and supports verification filters and pagination', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/doctors' });
    expect(anonymous.statusCode).toBe(401);

    const clinician = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors',
      headers: headers(doctor.accessToken),
    });
    expect(clinician.statusCode).toBe(403);

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?verificationStatus=verified&limit=3',
      headers: headers(admin.accessToken),
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = first.json<DoctorDetailListResponse>();
    expect(firstPage.data).toHaveLength(3);
    expect(firstPage.data.every((item) => item.verificationStatus === 'verified')).toBe(true);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/doctors?' +
        new URLSearchParams({
          verificationStatus: 'verified',
          limit: '3',
          cursor: firstPage.page.nextCursor as string,
        }).toString(),
      headers: headers(admin.accessToken),
    });
    expect(second.statusCode, second.body).toBe(200);
    const secondPage = second.json<DoctorDetailListResponse>();
    expect(secondPage.data.length).toBeGreaterThan(0);
    expect(firstPage.data.map((item) => item.id)).not.toContain(secondPage.data[0]?.id);

    const allVerified = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?verificationStatus=verified&limit=100',
      headers: headers(admin.accessToken),
    });
    expect(allVerified.json<DoctorDetailListResponse>().data.length).toBeGreaterThanOrEqual(8);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?verificationStatus=pending',
      headers: headers(admin.accessToken),
    });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json<DoctorDetailListResponse>().data).toHaveLength(0);

    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?cursor=not-a-cursor',
      headers: headers(admin.accessToken),
    });
    expect(invalidCursor.statusCode).toBe(400);

    const invalidStatus = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?verificationStatus=unknown',
      headers: headers(admin.accessToken),
    });
    expect(invalidStatus.statusCode).toBe(400);

    const invalidLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?limit=0',
      headers: headers(admin.accessToken),
    });
    expect(invalidLimit.statusCode).toBe(400);
  });

  it('updates verification state with idempotency, session revocation, audit and outbox', async () => {
    const missingKey = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${target.id}/verification`,
      headers: headers(admin.accessToken),
      payload: { status: 'suspended', reason: REVIEW_REASON },
    });
    expect(missingKey.statusCode).toBe(400);

    const invalidStatus = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${target.id}/verification`,
      headers: headers(admin.accessToken, `admin-invalid-${randomUUID()}`),
      payload: { status: 'active' },
    });
    expect(invalidStatus.statusCode).toBe(400);

    const unknownDoctor = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${randomUUID()}/verification`,
      headers: headers(admin.accessToken, `admin-missing-${randomUUID()}`),
      payload: { status: 'verified' },
    });
    expect(unknownDoctor.statusCode).toBe(404);

    const suspendKey = `admin-suspend-${randomUUID()}`;
    const suspended = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${target.id}/verification`,
      headers: headers(admin.accessToken, suspendKey),
      payload: { status: 'suspended', reason: REVIEW_REASON },
    });
    expect(suspended.statusCode, suspended.body).toBe(200);
    const suspendedDoctor = suspended.json<DoctorDetail>();
    expect(suspendedDoctor).toMatchObject({
      id: target.id,
      verificationStatus: 'suspended',
      acceptingNewPatients: false,
    });
    expect(suspendedDoctor.verifiedAt).toBe(target.verifiedAt);

    const replay = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${target.id}/verification`,
      headers: headers(admin.accessToken, suspendKey),
      payload: { status: 'suspended', reason: REVIEW_REASON },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<DoctorDetail>().verificationStatus).toBe('suspended');

    const sameState = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${target.id}/verification`,
      headers: headers(admin.accessToken, `admin-same-${randomUUID()}`),
      payload: { status: 'suspended' },
    });
    expect(sameState.statusCode, sameState.body).toBe(200);
    expect(sameState.json<DoctorDetail>().verificationStatus).toBe('suspended');

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: doctor.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    const suspendedList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?verificationStatus=suspended&limit=100',
      headers: headers(admin.accessToken),
    });
    expect(suspendedList.statusCode, suspendedList.body).toBe(200);
    expect(suspendedList.json<DoctorDetailListResponse>().data.map((item) => item.id)).toContain(
      target.id,
    );

    const storedReason = await database.query<{ verification_reason: string | null }>(
      'SELECT verification_reason FROM doctors WHERE user_id = $1',
      [target.id],
    );
    expect(storedReason.rows[0]?.verification_reason).toBe(REVIEW_REASON);

    const audit = await database.query<{
      metadata_text: string;
      before_hash: string | null;
      after_hash: string | null;
    }>(
      `SELECT metadata::text AS metadata_text,
              before_hash,
              after_hash
         FROM audit_logs
        WHERE resource_id = $1 AND action = 'doctor.verification_updated'
        ORDER BY occurred_at ASC`,
      [target.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.before_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.rows[0]?.after_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.rows[0]?.before_hash).not.toBe(audit.rows[0]?.after_hash);
    expect(audit.rows[0]?.metadata_text).not.toContain(REVIEW_REASON);

    const restoreKey = `admin-restore-${randomUUID()}`;
    const restored = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/doctors/${target.id}/verification`,
      headers: headers(admin.accessToken, restoreKey),
      payload: { status: 'verified' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const restoredDoctor = restored.json<DoctorDetail>();
    expect(restoredDoctor.verificationStatus).toBe('verified');
    expect(restoredDoctor.acceptingNewPatients).toBe(true);
    expect(restoredDoctor.verifiedAt).not.toBeNull();

    const restoredList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctors?verificationStatus=suspended&limit=100',
      headers: headers(admin.accessToken),
    });
    expect(restoredList.json<DoctorDetailListResponse>().data).toHaveLength(0);

    const outbox = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'doctor.verification_updated'`,
      [target.id],
    );
    expect(outbox.rows[0]?.count).toBe('2');

    const finalAudit = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE resource_id = $1 AND action = 'doctor.verification_updated'`,
      [target.id],
    );
    expect(finalAudit.rows[0]?.count).toBe('2');
  });
});
