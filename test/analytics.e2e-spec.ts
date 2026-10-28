import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTotpCode } from '../src/common/security/totp.js';
import type { LoginResponse, SessionResponse } from '../src/modules/auth/auth.types.js';
import type {
  AnalyticsOverview,
  ConsultationsAnalytics,
  DoctorUtilizationResponse,
  RevenueAnalytics,
  SpecialtyAnalyticsResponse,
} from '../src/modules/analytics/analytics.types.js';
import { createTestApp } from './utils/create-test-app.js';

const DEMO_PASSWORD = 'DemoPass!2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

interface ErrorResponse {
  error: { code: string; message: string };
}

function isSession(response: LoginResponse): response is SessionResponse {
  return 'accessToken' in response;
}

function headers(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

describe('Admin analytics (e2e)', () => {
  let app: NestFastifyApplication;
  let admin: SessionResponse;
  let doctor: SessionResponse;
  let from: string;
  let to: string;
  let rangeQuery: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login('admin@amrutam.local');
    doctor = await login('aarav.mehta@amrutam.local');

    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    from = start.toISOString();
    to = end.toISOString();
    rangeQuery = new URLSearchParams({ from, to }).toString();
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

  async function overview(): Promise<AnalyticsOverview> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/overview?${rangeQuery}`,
      headers: headers(admin.accessToken),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AnalyticsOverview>();
  }

  it('requires admin authorization for every analytics endpoint', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/overview?${rangeQuery}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const clinician = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/overview?${rangeQuery}`,
      headers: headers(doctor.accessToken),
    });
    expect(clinician.statusCode).toBe(403);

    for (const path of [
      'overview',
      'consultations',
      'revenue',
      'doctor-utilization',
      'specialties',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/${path}?${rangeQuery}`,
        headers: headers(doctor.accessToken),
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('reports overview totals, revenue and workforce metrics', async () => {
    const result = await overview();
    expect(result.range.from).toBe(from);
    expect(result.range.to).toBe(to);
    expect(result.consultations.total).toBeGreaterThanOrEqual(28);
    expect(result.consultations.completed).toBeGreaterThanOrEqual(28);
    expect(result.consultations.cancelled).toBeGreaterThanOrEqual(0);
    expect(result.consultations.noShow).toBeGreaterThanOrEqual(0);
    expect(result.consultations.completionRate).toBeGreaterThan(0);
    expect(result.consultations.completionRate).toBeLessThanOrEqual(1);
    expect(result.revenue.capturedCents).toBeGreaterThan(0);
    expect(result.revenue.refundedCents).toBeGreaterThanOrEqual(0);
    expect(result.revenue.netCents).toBe(
      result.revenue.capturedCents - result.revenue.refundedCents,
    );
    expect(result.revenue.currency).toBe('INR');
    expect(result.doctors.active).toBeGreaterThanOrEqual(8);
    expect(result.doctors.verified).toBeGreaterThanOrEqual(8);
    expect(result.patients.total).toBeGreaterThanOrEqual(20);
    expect(result.patients.new).toBeGreaterThanOrEqual(20);
  });

  it('returns gap-free consultation buckets that reconcile with the overview', async () => {
    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/consultations?${rangeQuery}&interval=day`,
      headers: headers(admin.accessToken),
    });
    expect(result.statusCode, result.body).toBe(200);
    const series = result.json<ConsultationsAnalytics>();
    expect(series.interval).toBe('day');
    expect(series.buckets).toHaveLength(31);
    const totals = series.buckets.reduce(
      (sum, bucket) => ({
        total: sum.total + bucket.total,
        completed: sum.completed + bucket.completed,
        cancelled: sum.cancelled + bucket.cancelled,
        noShow: sum.noShow + bucket.noShow,
      }),
      { total: 0, completed: 0, cancelled: 0, noShow: 0 },
    );
    const summary = await overview();
    expect(totals.total).toBe(summary.consultations.total);
    expect(totals.completed).toBe(summary.consultations.completed);
    expect(totals.cancelled).toBe(summary.consultations.cancelled);
    expect(totals.noShow).toBe(summary.consultations.noShow);
    expect(series.buckets.every((bucket) => bucket.bucketStart.endsWith('Z'))).toBe(true);

    const weekly = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/consultations?${rangeQuery}&interval=week`,
      headers: headers(admin.accessToken),
    });
    expect(weekly.statusCode, weekly.body).toBe(200);
    expect(
      weekly.json<ConsultationsAnalytics>().buckets.reduce((sum, bucket) => sum + bucket.total, 0),
    ).toBe(totals.total);
  });

  it('reports gross captured revenue and refund-ledger entries by bucket', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/revenue?${rangeQuery}&interval=day`,
      headers: headers(admin.accessToken),
    });
    expect(response.statusCode, response.body).toBe(200);
    const revenue = response.json<RevenueAnalytics>();
    expect(revenue.currency).toBe('INR');
    expect(revenue.buckets).toHaveLength(31);
    const totals = revenue.buckets.reduce(
      (sum, bucket) => ({
        captured: sum.captured + bucket.capturedCents,
        refunded: sum.refunded + bucket.refundedCents,
        net: sum.net + bucket.netCents,
      }),
      { captured: 0, refunded: 0, net: 0 },
    );
    const summary = await overview();
    expect(totals.captured).toBe(summary.revenue.capturedCents);
    expect(totals.refunded).toBe(summary.revenue.refundedCents);
    expect(totals.net).toBe(summary.revenue.netCents);
    expect(
      revenue.buckets.every(
        (bucket) => bucket.netCents === bucket.capturedCents - bucket.refundedCents,
      ),
    ).toBe(true);
  });

  it('reports utilization by doctor and specialty performance', async () => {
    const utilizationResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/doctor-utilization?${rangeQuery}`,
      headers: headers(admin.accessToken),
    });
    expect(utilizationResponse.statusCode, utilizationResponse.body).toBe(200);
    const utilization = utilizationResponse.json<DoctorUtilizationResponse>();
    expect(utilization.data.length).toBeGreaterThanOrEqual(8);
    expect(
      utilization.data.every(
        (item) =>
          item.utilizationRate >= 0 &&
          item.utilizationRate <= 1 &&
          item.availableSlots >= 0 &&
          item.bookedSlots >= 0,
      ),
    ).toBe(true);
    expect(
      utilization.data.reduce((sum, item) => sum + item.completedConsultations, 0),
    ).toBeGreaterThanOrEqual(28);

    const doctorId = utilization.data[0]?.doctorId as string;
    const filteredResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/doctor-utilization?${rangeQuery}&doctorId=${doctorId}`,
      headers: headers(admin.accessToken),
    });
    expect(filteredResponse.statusCode, filteredResponse.body).toBe(200);
    const filtered = filteredResponse.json<DoctorUtilizationResponse>();
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.doctorId).toBe(doctorId);

    const specialtiesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/specialties?${rangeQuery}`,
      headers: headers(admin.accessToken),
    });
    expect(specialtiesResponse.statusCode, specialtiesResponse.body).toBe(200);
    const specialties = specialtiesResponse.json<SpecialtyAnalyticsResponse>();
    const summary = await overview();
    expect(specialties.currency).toBe('INR');
    expect(specialties.data.length).toBeGreaterThan(0);
    expect(specialties.data.reduce((sum, item) => sum + item.consultations, 0)).toBe(
      summary.consultations.total,
    );
    expect(specialties.data.every((item) => item.revenueCents >= 0)).toBe(true);
    expect(new Set(specialties.data.map((item) => item.specialization)).size).toBe(
      specialties.data.length,
    );
  });

  it('rejects invalid ranges, intervals and doctor filters', async () => {
    const inverted = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/analytics/overview?' +
        new URLSearchParams({ from: to, to: from }).toString(),
      headers: headers(admin.accessToken),
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');

    const tooLongFrom = new Date(Date.parse(to) - 367 * 86_400_000).toISOString();
    const tooLong = await app.inject({
      method: 'GET',
      url:
        '/api/v1/admin/analytics/consultations?' +
        new URLSearchParams({ from: tooLongFrom, to }).toString(),
      headers: headers(admin.accessToken),
    });
    expect(tooLong.statusCode).toBe(400);

    const invalidInterval = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/revenue?${rangeQuery}&interval=hour`,
      headers: headers(admin.accessToken),
    });
    expect(invalidInterval.statusCode).toBe(400);

    const invalidDoctor = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/doctor-utilization?${rangeQuery}&doctorId=${randomUUID()}x`,
      headers: headers(admin.accessToken),
    });
    expect(invalidDoctor.statusCode).toBe(400);

    const invalidDate = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/overview?from=not-a-date',
      headers: headers(admin.accessToken),
    });
    expect(invalidDate.statusCode).toBe(400);
  });
});
