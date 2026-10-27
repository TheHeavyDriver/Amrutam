import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AvailabilityListResponse,
  DoctorDetail,
  DoctorListResponse,
  DoctorSummary,
} from '../src/modules/doctors/doctors.types.js';
import { createTestApp } from './utils/create-test-app.js';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

describe('Doctor discovery (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function list(query = ''): Promise<DoctorListResponse> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors${query ? `?${query}` : ''}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    return response.json<DoctorListResponse>();
  }

  async function collect(sort: string): Promise<DoctorSummary[]> {
    const seen: DoctorSummary[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ sort, limit: '3' });
      if (cursor) {
        params.set('cursor', cursor);
      }

      const body = await list(params.toString());
      seen.push(...body.data);

      if (!body.page.hasMore) {
        expect(body.page.nextCursor).toBeNull();
        return seen;
      }

      expect(body.page.nextCursor).toBeTruthy();
      cursor = body.page.nextCursor;
    }

    throw new Error('Doctor pagination did not terminate');
  }

  it('paginates every sort deterministically without duplicates', async () => {
    for (const sort of ['rating_desc', 'fee_asc', 'fee_desc', 'next_available']) {
      const doctors = await collect(sort);

      expect(doctors.length).toBeGreaterThanOrEqual(8);
      expect(new Set(doctors.map((doctor) => doctor.id)).size).toBe(doctors.length);

      if (sort === 'fee_asc') {
        const fees = doctors.map((doctor) => doctor.consultationFee.amountCents);
        expect(fees).toEqual([...fees].sort((a, b) => a - b));
      }

      if (sort === 'fee_desc') {
        const fees = doctors.map((doctor) => doctor.consultationFee.amountCents);
        expect(fees).toEqual([...fees].sort((a, b) => b - a));
      }

      if (sort === 'rating_desc') {
        const ratings = doctors.map((doctor) => doctor.rating);
        expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
      }
    }
  });

  it('applies specialty, city, language, fee, text, and availability filters', async () => {
    const cardiology = await list('specialization=Cardiology');
    expect(cardiology.data).toHaveLength(1);
    expect(cardiology.data[0]?.fullName).toContain('Aarav');

    const city = await list('city=Kochi');
    expect(city.data).toHaveLength(1);
    expect(city.data[0]?.city).toBe('Kochi');

    const language = await list('language=ta');
    expect(language.data).toHaveLength(1);
    expect(language.data[0]?.languages).toContain('ta');

    const fee = await list('maxFeeCents=80000');
    expect(fee.data.length).toBeGreaterThanOrEqual(3);
    expect(fee.data.every((doctor) => doctor.consultationFee.amountCents <= 80_000)).toBe(true);

    const text = await list('query=Cardio');
    expect(text.data.some((doctor) => doctor.specialization === 'Cardiology')).toBe(true);

    const from = new Date();
    const to = new Date(from.getTime() + 7 * 86_400_000);
    const available = await list(
      new URLSearchParams({
        availableFrom: from.toISOString(),
        availableTo: to.toISOString(),
        limit: '50',
      }).toString(),
    );
    expect(available.data.length).toBeGreaterThan(0);
    expect(
      available.data.every(
        (doctor) =>
          doctor.nextAvailableAt !== null &&
          new Date(doctor.nextAvailableAt) >= from &&
          new Date(doctor.nextAvailableAt) < to,
      ),
    ).toBe(true);
  });

  it('returns doctor details and hides unknown or malformed ids', async () => {
    const doctors = await list('limit=1');
    const summary = doctors.data[0];

    if (!summary) {
      throw new Error('Expected a seeded doctor');
    }

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors/${summary.id}`,
    });
    expect(detailResponse.statusCode, detailResponse.body).toBe(200);

    const detail = detailResponse.json<DoctorDetail>();
    expect(detail).toMatchObject({
      id: summary.id,
      fullName: summary.fullName,
      verificationStatus: 'verified',
      timezone: 'Asia/Kolkata',
    });
    expect(detail.licenseNumber).toMatch(/^AMR-DOC-/);
    expect(new Date(detail.createdAt).toString()).not.toBe('Invalid Date');

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors/${randomUUID()}`,
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/doctors/not-a-uuid',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');
  });

  it('lists bookable availability with cursor pagination', async () => {
    const doctors = await list('sort=next_available&limit=50');
    const doctor = doctors.data.find((candidate) => candidate.nextAvailableAt !== null);

    if (!doctor) {
      throw new Error('Expected a doctor with availability');
    }

    const from = new Date(doctor.nextAvailableAt as string);
    const to = new Date(from.getTime() + 14 * 86_400_000);
    const url = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      limit: '2',
    });

    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors/${doctor.id}/availability?${url.toString()}`,
    });
    expect(first.statusCode, first.body).toBe(200);
    const firstPage = first.json<AvailabilityListResponse>();
    expect(firstPage.data.length).toBeGreaterThan(0);
    expect(
      firstPage.data.every(
        (slot) =>
          slot.doctorId === doctor.id &&
          slot.status === 'available' &&
          slot.durationMinutes === 30 &&
          new Date(slot.startsAt) >= from &&
          new Date(slot.endsAt) <= to,
      ),
    ).toBe(true);

    if (firstPage.page.hasMore && firstPage.page.nextCursor) {
      url.set('cursor', firstPage.page.nextCursor);
      const second = await app.inject({
        method: 'GET',
        url: `/api/v1/doctors/${doctor.id}/availability?${url.toString()}`,
      });
      expect(second.statusCode, second.body).toBe(200);
      const secondPage = second.json<AvailabilityListResponse>();
      expect(secondPage.data[0]?.id).not.toBe(firstPage.data[0]?.id);
    }

    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors/${randomUUID()}/availability`,
    });
    expect(missing.statusCode).toBe(404);

    const tooWide = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors/${doctor.id}/availability?from=${from.toISOString()}&to=${new Date(
        from.getTime() + 91 * 86_400_000,
      ).toISOString()}`,
    });
    expect(tooWide.statusCode).toBe(400);
  });

  it('rejects invalid filters and cursor/sort mismatches', async () => {
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/doctors?minFeeCents=90000&maxFeeCents=10000',
    });
    expect(invalid.statusCode).toBe(400);

    const first = await list('sort=fee_asc&limit=1');
    const cursor = first.page.nextCursor;
    expect(cursor).toBeTruthy();

    const mismatch = await app.inject({
      method: 'GET',
      url: `/api/v1/doctors?sort=rating_desc&cursor=${encodeURIComponent(cursor as string)}`,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json<ErrorResponse>().error.message).toBe('Invalid cursor');
  });
});
