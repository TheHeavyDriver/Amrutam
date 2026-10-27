import { randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/common/security/encryption.js';
import { generateTotpCode } from '../src/common/security/totp.js';
import { DatabaseService } from '../src/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type {
  LoginResponse,
  RegistrationResponse,
  SessionResponse,
} from '../src/modules/auth/auth.types.js';
import type { UserProfile } from '../src/modules/users/users.types.js';
import { createTestApp } from './utils/create-test-app.js';

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const DEMO_PASSWORD = 'DemoPass!2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const RUN_ID = randomUUID().slice(0, 8);

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Array<{ field: string; message: string }>;
  };
}

interface OutboxRow {
  payload: {
    template: string;
    encryptedToken: string;
  };
}

function uniqueEmail(label: string): string {
  return `e2e.${RUN_ID}.${label}.${randomUUID().slice(0, 8)}@example.test`;
}

function uniquePhone(): string {
  return `+9199${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

describe('Authentication and authorization (e2e)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let audit: AuditService;

  beforeAll(async () => {
    app = await createTestApp();
    database = app.get(DatabaseService);
    audit = app.get(AuditService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerPatient(
    label: string,
    password = DEMO_PASSWORD,
  ): Promise<{
    email: string;
    response: RegistrationResponse;
  }> {
    const email = uniqueEmail(label);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email,
        password,
        fullName: 'E2E Patient',
        phone: uniquePhone(),
        acceptedTerms: true,
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    return { email, response: response.json<RegistrationResponse>() };
  }

  async function login(email: string, password = DEMO_PASSWORD): Promise<SessionResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<LoginResponse>();
    expect(isSession(body), 'expected a session rather than an MFA challenge').toBe(true);
    return body as SessionResponse;
  }

  it('rejects protected routes without a bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/users/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorResponse>().error.code).toBe('UNAUTHORIZED');
  });

  it('registers, authenticates, and reads the authenticated profile', async () => {
    const { email, response: registration } = await registerPatient('register');
    expect(registration).toMatchObject({
      email,
      verificationRequired: false,
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email,
        password: DEMO_PASSWORD,
        fullName: 'Duplicate Patient',
        phone: uniquePhone(),
        acceptedTerms: true,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ErrorResponse>().error.code).toBe('EMAIL_ALREADY_REGISTERED');

    const session = await login(email);
    const profile = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    expect(profile.statusCode, profile.body).toBe(200);
    const user = profile.json<UserProfile>();
    expect(user).toMatchObject({
      email,
      role: 'patient',
      status: 'active',
      fullName: 'E2E Patient',
    });
    expect(user.dateOfBirth).toBeNull();

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { fullName: 'Updated E2E Patient', dateOfBirth: '1990-04-12' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<UserProfile>().dateOfBirth).toBe('1990-04-12');
    expect(updated.json<UserProfile>().fullName).toBe('Updated E2E Patient');

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { dateOfBirth: '12-04-1990' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<ErrorResponse>().error.details?.[0]?.field).toBe('dateOfBirth');
  });

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const { email } = await registerPatient('refresh');
    const session = await login(email);

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const next = rotated.json<SessionResponse>();
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(next.accessToken).not.toBe(session.accessToken);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json<ErrorResponse>().error.code).toBe('REFRESH_TOKEN_REUSED');

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${next.accessToken}` },
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<ErrorResponse>().error.code).toBe('SESSION_REVOKED');

    const rotatedAgain = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: next.refreshToken },
    });
    expect(rotatedAgain.statusCode).toBe(401);
  });

  it('logs out a session and invalidates its access token', async () => {
    const { email } = await registerPatient('logout');
    const session = await login(email);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { refreshToken: session.refreshToken },
    });
    expect(logout.statusCode, logout.body).toBe(200);
    expect(logout.json<{ message: string }>().message).toBe('Session revoked');

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json<ErrorResponse>().error.code).toBe('SESSION_REVOKED');
  });

  it('locks an account after repeated password failures', async () => {
    const { email } = await registerPatient('lockout');

    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'DefinitelyWrong!2026' },
      });
      expect(response.statusCode).toBe(401);
    }

    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: DEMO_PASSWORD },
    });
    expect(locked.statusCode).toBe(423);
    expect(locked.json<ErrorResponse>().error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('resets a password from the encrypted email outbox token', async () => {
    const { email } = await registerPatient('reset', 'InitialPass!2026');
    const initialSession = await login(email, 'InitialPass!2026');

    const forgot = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email },
    });
    expect(forgot.statusCode, forgot.body).toBe(200);

    const events = await database.query<OutboxRow>(
      `SELECT payload
         FROM outbox_events
        WHERE aggregate_id = (SELECT id FROM users WHERE email = $1)
          AND event_type = 'notification.email'
        ORDER BY created_at DESC
        LIMIT 1`,
      [email],
    );
    const payload = events.rows[0]?.payload;
    expect(payload?.template).toBe('reset_password');

    if (!payload) {
      throw new Error('Missing password reset outbox event');
    }

    const token = decryptSecret(payload.encryptedToken, TEST_ENCRYPTION_KEY);
    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'ResetPass!2026' },
    });
    expect(reset.statusCode, reset.body).toBe(200);

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${initialSession.accessToken}` },
    });
    expect(oldSession.statusCode).toBe(401);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'InitialPass!2026' },
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await login(email, 'ResetPass!2026');
    expect(newPassword.accessToken).toBeTruthy();
  });

  it('requires TOTP for the seeded admin and enforces role policy', async () => {
    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@amrutam.local', password: DEMO_PASSWORD },
    });
    expect(challengeResponse.statusCode, challengeResponse.body).toBe(200);
    const challenge = challengeResponse.json<LoginResponse>();

    expect(isSession(challenge)).toBe(false);
    if (isSession(challenge)) {
      throw new Error('Expected an MFA challenge');
    }

    const code = generateTotpCode(DEMO_TOTP_SECRET);
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: { mfaToken: challenge.mfaToken, code },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const adminSession = verified.json<SessionResponse>();
    expect(adminSession.user).toMatchObject({ email: 'admin@amrutam.local', role: 'admin' });

    const patient = await registerPatient('role');
    const patientSession = await login(patient.email);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: { authorization: `Bearer ${patientSession.accessToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const alreadyEnabled = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: { authorization: `Bearer ${adminSession.accessToken}` },
    });
    expect(alreadyEnabled.statusCode).toBe(409);
  });

  it('restricts audit browsing to admins and returns a verifiable page', async () => {
    const patient = await registerPatient('audit-role');
    const patientSession = await login(patient.email);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${patientSession.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<ErrorResponse>().error.code).toBe('FORBIDDEN');

    const adminChallenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@amrutam.local', password: DEMO_PASSWORD },
    });
    const challenge = adminChallenge.json<LoginResponse>();
    expect(isSession(challenge)).toBe(false);

    if (isSession(challenge)) {
      throw new Error('Expected an MFA challenge');
    }

    const adminMfa = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      payload: {
        mfaToken: challenge.mfaToken,
        code: generateTotpCode(DEMO_TOTP_SECRET),
      },
    });
    expect(adminMfa.statusCode, adminMfa.body).toBe(200);
    const adminSession = adminMfa.json<SessionResponse>();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?limit=5&action=auth.login.succeeded',
      headers: { authorization: `Bearer ${adminSession.accessToken}` },
    });
    expect(list.statusCode, list.body).toBe(200);
    const page = list.json<{
      data: Array<{ action: string; entryHash: string }>;
      page: { hasMore: boolean; nextCursor: string | null };
    }>();
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((entry) => entry.action === 'auth.login.succeeded')).toBe(true);
    expect(page.data[0]?.entryHash).toMatch(/^[0-9a-f]{64}$/);

    const verify = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs/verify',
      headers: { authorization: `Bearer ${adminSession.accessToken}` },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json<{ valid: boolean }>().valid).toBe(true);

    const badCursor = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?cursor=not-a-cursor',
      headers: { authorization: `Bearer ${adminSession.accessToken}` },
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json<ErrorResponse>().error.message).toBe('Invalid audit cursor');
  });

  it('rejects invalid request bodies with field details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'not-an-email',
        password: 'short',
        fullName: 'X',
        phone: '123',
        acceptedTerms: false,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorResponse>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.map((detail) => detail.field)).toEqual(
      expect.arrayContaining(['email', 'password', 'phone', 'acceptedTerms']),
    );
  });

  it('keeps the audit hash chain valid and enforces append-only storage', async () => {
    const verification = await audit.verifyChain();
    expect(verification.valid, JSON.stringify(verification)).toBe(true);
    expect(verification.checkedEntries).toBeGreaterThan(0);

    const actions = await database.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action`,
    );
    expect(actions.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'auth.registration.created',
        'auth.login.succeeded',
        'auth.session.refreshed',
        'auth.session.reuse_detected',
        'auth.logout',
        'auth.login.locked',
        'auth.password.reset_requested',
        'auth.password.reset',
        'user.profile.updated',
      ]),
    );

    await expect(
      database.query(`UPDATE audit_logs SET action = 'tampered' WHERE action = 'auth.logout'`),
    ).rejects.toThrow(/append-only/);
  });
});
