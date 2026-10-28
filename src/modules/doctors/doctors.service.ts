import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  CacheService,
  DOCTOR_AVAILABILITY_TTL_SECONDS,
  DOCTOR_DETAIL_TTL_SECONDS,
  DOCTOR_LIST_TTL_SECONDS,
} from '../../cache/cache.service.js';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../../common/idempotency/idempotency.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  decodeAvailabilityCursor,
  decodeDoctorCursor,
  encodeAvailabilityCursor,
  encodeDoctorCursor,
} from './doctors.cursor.js';
import type { DoctorCursor } from './doctors.cursor.js';
import type {
  AvailabilityQuery,
  CreateAvailabilitySlotInput,
  ListDoctorsQuery,
} from './doctors.schemas.js';
import type {
  AvailabilityListResponse,
  AvailabilitySlot,
  DoctorDetail,
  DoctorListResponse,
  DoctorSort,
  DoctorSummary,
  Money,
} from './doctors.types.js';

const DEFAULT_AVAILABILITY_DAYS = 14;
const MAX_AVAILABILITY_DAYS = 90;
const DAY_MS = 86_400_000;

interface DoctorSummaryRow {
  id: string;
  full_name: string;
  specialization: string;
  sub_specialties: string[];
  languages: string[];
  years_experience: number;
  consultation_fee_cents: number;
  currency: string;
  city: string | null;
  rating: string;
  rating_count: number;
  accepting_new_patients: boolean;
  next_available_at: Date | null;
  bio: string | null;
}

interface DoctorDetailRow extends DoctorSummaryRow {
  license_number: string;
  verification_status: DoctorDetail['verificationStatus'];
  verified_at: Date | null;
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

interface AvailabilityRow {
  id: string;
  doctor_id: string;
  starts_at: Date;
  ends_at: Date;
  status: AvailabilitySlot['status'];
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

@Injectable()
export class DoctorsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly cache: CacheService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListDoctorsQuery): Promise<DoctorListResponse> {
    const cacheKey = `amrutam:v1:doctors:list:${CacheService.keyHash({
      ...query,
      availableFrom: query.availableFrom?.toISOString() ?? null,
      availableTo: query.availableTo?.toISOString() ?? null,
    })}`;

    return this.cache.getOrSet(cacheKey, DOCTOR_LIST_TTL_SECONDS, () => this.queryList(query));
  }

  async getById(doctorId: string): Promise<DoctorDetail> {
    const cacheKey = `amrutam:v1:doctors:detail:${doctorId}`;

    return this.cache.getOrSet(cacheKey, DOCTOR_DETAIL_TTL_SECONDS, async () => {
      const { rows } = await this.database.query<DoctorDetailRow>(
        `${this.detailSelect()}
          WHERE d.user_id = $1
            AND d.verification_status = 'verified'
            AND u.status = 'active'`,
        [doctorId],
      );
      const row = rows[0];

      if (!row) {
        throw new ApiException(HttpStatus.NOT_FOUND, {
          code: ErrorCodes.NOT_FOUND,
          message: 'Doctor not found',
        });
      }

      return this.toDetail(row);
    });
  }

  async listAvailability(
    doctorId: string,
    query: AvailabilityQuery,
  ): Promise<AvailabilityListResponse> {
    const { from, to } = this.availabilityRange(query, true);
    const cacheKey = `amrutam:v1:doctors:availability:${doctorId}:${CacheService.keyHash({
      from: from.toISOString(),
      to: to.toISOString(),
      cursor: query.cursor ?? null,
      limit: query.limit,
    })}`;

    return this.cache.getOrSet(cacheKey, DOCTOR_AVAILABILITY_TTL_SECONDS, async () => {
      await this.assertVerifiedDoctor(doctorId);
      return this.queryAvailability(doctorId, from, to, query, true);
    });
  }

  async listOwnAvailability(
    user: AuthenticatedUser,
    query: AvailabilityQuery,
  ): Promise<AvailabilityListResponse> {
    const { from, to } = this.availabilityRange(query, false);
    await this.assertDoctor(user.id);

    return this.queryAvailability(user.id, from, to, query, false);
  }

  async createAvailabilitySlot(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    input: CreateAvailabilitySlotInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<AvailabilitySlot>> {
    const result = await this.idempotency.execute<AvailabilitySlot>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: '/doctors/me/availability',
        body: {
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
        },
        request,
      },
      async (client) => {
        await this.assertDoctor(user.id, client);

        if (input.startsAt.getTime() <= Date.now()) {
          throw new ApiException(HttpStatus.BAD_REQUEST, {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Availability must start in the future',
            details: [{ field: 'startsAt', message: 'Must be a future timestamp' }],
          });
        }

        let row: AvailabilityRow;

        try {
          const { rows } = await client.query<AvailabilityRow>(
            `INSERT INTO availability_slots (doctor_id, starts_at, ends_at)
             VALUES ($1, $2, $3)
             RETURNING id, doctor_id, starts_at, ends_at, status`,
            [user.id, input.startsAt, input.endsAt],
          );
          row = rows[0] as AvailabilityRow;
        } catch (error) {
          if (isPostgresError(error, '23P01') || isPostgresError(error, '23505')) {
            throw new ApiException(HttpStatus.CONFLICT, {
              code: ErrorCodes.SLOT_UNAVAILABLE,
              message: 'This slot overlaps existing availability',
            });
          }

          throw error;
        }

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'doctor.availability_created',
            resourceType: 'availability_slot',
            resourceId: row.id,
            request,
            after: {
              startsAt: row.starts_at.toISOString(),
              endsAt: row.ends_at.toISOString(),
              status: row.status,
            },
            metadata: { doctorId: user.id },
          },
          client,
        );

        return { status: HttpStatus.CREATED, body: this.toAvailability(row) };
      },
    );

    await this.invalidateDoctor(user.id);
    return result;
  }

  async deleteAvailabilitySlot(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    slotId: string,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<void>> {
    const result = await this.idempotency.execute<void>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'DELETE',
        path: `/doctors/me/availability/${slotId}`,
        body: null,
        request,
      },
      async (client) => {
        const { rows } = await client.query<AvailabilityRow>(
          `SELECT id, doctor_id, starts_at, ends_at, status
             FROM availability_slots
            WHERE id = $1
              AND doctor_id = $2
            FOR UPDATE`,
          [slotId, user.id],
        );
        const row = rows[0];

        if (!row) {
          throw new ApiException(HttpStatus.NOT_FOUND, {
            code: ErrorCodes.NOT_FOUND,
            message: 'Availability slot not found',
          });
        }

        if (row.status !== 'available') {
          throw new ApiException(HttpStatus.CONFLICT, {
            code: ErrorCodes.SLOT_UNAVAILABLE,
            message: 'Only available slots can be removed',
          });
        }

        await client.query('DELETE FROM availability_slots WHERE id = $1', [slotId]);
        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'doctor.availability_deleted',
            resourceType: 'availability_slot',
            resourceId: row.id,
            request,
            before: {
              startsAt: row.starts_at.toISOString(),
              endsAt: row.ends_at.toISOString(),
              status: row.status,
            },
            after: null,
            metadata: { doctorId: user.id },
          },
          client,
        );

        return { status: HttpStatus.NO_CONTENT, body: undefined };
      },
    );

    await this.invalidateDoctor(user.id);
    return result;
  }

  async invalidateDoctor(doctorId: string): Promise<void> {
    await Promise.all([
      this.cache.delete(`amrutam:v1:doctors:detail:${doctorId}`),
      this.cache.deleteByPrefix('amrutam:v1:doctors:list:'),
      this.cache.deleteByPrefix(`amrutam:v1:doctors:availability:${doctorId}:`),
    ]);
  }

  private availabilityRange(
    query: AvailabilityQuery,
    clampToNow: boolean,
  ): { from: Date; to: Date } {
    const now = new Date();
    const from = clampToNow && (!query.from || query.from < now) ? now : (query.from ?? now);
    const to = query.to ?? addDays(from, DEFAULT_AVAILABILITY_DAYS);

    if (to.getTime() - from.getTime() > MAX_AVAILABILITY_DAYS * DAY_MS) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Availability range cannot exceed ${MAX_AVAILABILITY_DAYS} days`,
      });
    }

    return { from, to };
  }

  private async assertVerifiedDoctor(doctorId: string): Promise<void> {
    const doctor = await this.database.query<{ id: string }>(
      `SELECT d.user_id AS id
         FROM doctors d
         JOIN users u ON u.id = d.user_id
        WHERE d.user_id = $1
          AND d.verification_status = 'verified'
          AND u.status = 'active'`,
      [doctorId],
    );

    if (!doctor.rows[0]) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Doctor not found',
      });
    }
  }

  private async assertDoctor(doctorId: string, client?: PoolClient): Promise<void> {
    const result = client
      ? await client.query<{ id: string }>('SELECT user_id AS id FROM doctors WHERE user_id = $1', [
          doctorId,
        ])
      : await this.database.query<{ id: string }>(
          'SELECT user_id AS id FROM doctors WHERE user_id = $1',
          [doctorId],
        );

    if (!result.rows[0]) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Doctor profile not found',
      });
    }
  }

  private async queryAvailability(
    doctorId: string,
    from: Date,
    to: Date,
    query: AvailabilityQuery,
    onlyAvailable: boolean,
  ): Promise<AvailabilityListResponse> {
    if (to <= from) {
      return { data: [], page: { hasMore: false, nextCursor: null } };
    }

    const conditions = ['doctor_id = $1', 'starts_at >= $2', 'starts_at < $3'];
    const values: unknown[] = [doctorId, from, to];

    if (onlyAvailable) {
      conditions.push("status = 'available'");
    }

    if (query.cursor) {
      const cursor = decodeAvailabilityCursor(query.cursor);
      values.push(new Date(cursor.startsAt));
      const startsAtParameter = `$${values.length}`;
      values.push(cursor.id);
      const idParameter = `$${values.length}`;
      conditions.push(
        `(starts_at > ${startsAtParameter} OR ` +
          `(starts_at = ${startsAtParameter} AND id > ${idParameter}))`,
      );
    }

    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;

    const { rows } = await this.database.query<AvailabilityRow>(
      `SELECT id, doctor_id, starts_at, ends_at, status
         FROM availability_slots
        WHERE ${conditions.join(' AND ')}
        ORDER BY starts_at ASC, id ASC
        LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toAvailability(row)),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeAvailabilityCursor({
                v: 1,
                startsAt: last.starts_at.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  private async queryList(query: ListDoctorsQuery): Promise<DoctorListResponse> {
    const conditions = ["d.verification_status = 'verified'", "u.status = 'active'"];
    const values: unknown[] = [query.availableFrom ?? null, query.availableTo ?? null];

    if (query.query) {
      values.push(`%${escapeLike(query.query)}%`);
      const pattern = `$${values.length}`;
      conditions.push(
        `(p.full_name ILIKE ${pattern} ESCAPE '\\' ` +
          `OR d.specialization ILIKE ${pattern} ESCAPE '\\' ` +
          `OR COALESCE(d.bio, '') ILIKE ${pattern} ESCAPE '\\')`,
      );
    }

    if (query.specialization) {
      values.push(query.specialization);
      conditions.push(`lower(d.specialization) = lower($${values.length})`);
    }

    if (query.language) {
      values.push(query.language);
      conditions.push(`d.languages @> ARRAY[$${values.length}]::text[]`);
    }

    if (query.city) {
      values.push(query.city);
      conditions.push(`lower(d.city) = lower($${values.length})`);
    }

    if (query.minFeeCents !== undefined) {
      values.push(query.minFeeCents);
      conditions.push(`d.consultation_fee_cents >= $${values.length}`);
    }

    if (query.maxFeeCents !== undefined) {
      values.push(query.maxFeeCents);
      conditions.push(`d.consultation_fee_cents <= $${values.length}`);
    }

    if (query.availableFrom || query.availableTo) {
      conditions.push('na.next_available_at IS NOT NULL');
    }

    const cursor = query.cursor ? decodeDoctorCursor(query.cursor, query.sort) : null;

    if (cursor) {
      if (query.sort === 'rating_desc') {
        values.push(cursor.rating, cursor.ratingCount, cursor.id);
        const ratingParameter = `$${values.length - 2}`;
        const countParameter = `$${values.length - 1}`;
        const idParameter = `$${values.length}`;
        conditions.push(
          `(d.rating < ${ratingParameter}::numeric ` +
            `OR (d.rating = ${ratingParameter}::numeric AND d.rating_count < ${countParameter}) ` +
            `OR (d.rating = ${ratingParameter}::numeric AND d.rating_count = ${countParameter} ` +
            `AND d.user_id > ${idParameter}::uuid))`,
        );
      }

      if (query.sort === 'fee_asc' || query.sort === 'fee_desc') {
        values.push(cursor.feeCents, cursor.id);
        const feeParameter = `$${values.length - 1}`;
        const idParameter = `$${values.length}`;
        const comparison = query.sort === 'fee_asc' ? '>' : '<';
        conditions.push(
          `(d.consultation_fee_cents ${comparison} ${feeParameter}::integer ` +
            `OR (d.consultation_fee_cents = ${feeParameter}::integer ` +
            `AND d.user_id > ${idParameter}::uuid))`,
        );
      }

      if (query.sort === 'next_available') {
        if (cursor.nextAvailableAt === null || cursor.nextAvailableAt === undefined) {
          values.push(cursor.id);
          conditions.push(`(na.next_available_at IS NULL AND d.user_id > $${values.length}::uuid)`);
        } else {
          values.push(new Date(cursor.nextAvailableAt), cursor.id);
          const availableParameter = `$${values.length - 1}`;
          const idParameter = `$${values.length}`;
          conditions.push(
            `(na.next_available_at > ${availableParameter}::timestamptz ` +
              `OR (na.next_available_at = ${availableParameter}::timestamptz ` +
              `AND d.user_id > ${idParameter}::uuid) ` +
              `OR na.next_available_at IS NULL)`,
          );
        }
      }
    }

    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;

    const { rows } = await this.database.query<DoctorSummaryRow>(
      `SELECT d.user_id AS id,
              p.full_name,
              d.specialization,
              d.sub_specialties,
              d.languages,
              d.years_experience,
              d.consultation_fee_cents,
              d.currency,
              d.city,
              d.rating,
              d.rating_count,
              d.accepting_new_patients,
              na.next_available_at,
              d.bio
         FROM doctors d
         JOIN users u ON u.id = d.user_id
         JOIN profiles p ON p.user_id = d.user_id
         LEFT JOIN LATERAL (
           SELECT min(s.starts_at) AS next_available_at
             FROM availability_slots s
            WHERE s.doctor_id = d.user_id
              AND s.status = 'available'
              AND s.starts_at >= GREATEST(now(), COALESCE($1::timestamptz, now()))
              AND ($2::timestamptz IS NULL OR s.starts_at < $2::timestamptz)
         ) na ON true
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${this.orderBy(query.sort)}
        LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toSummary(row)),
      page: {
        hasMore,
        nextCursor: hasMore && last ? encodeDoctorCursor(this.toCursor(last, query.sort)) : null,
      },
    };
  }

  private detailSelect(): string {
    return `SELECT d.user_id AS id,
                   p.full_name,
                   d.specialization,
                   d.sub_specialties,
                   d.languages,
                   d.years_experience,
                   d.consultation_fee_cents,
                   d.currency,
                   d.city,
                   d.rating,
                   d.rating_count,
                   d.accepting_new_patients,
                   na.next_available_at,
                   d.bio,
                   d.license_number,
                   d.verification_status,
                   d.verified_at,
                   d.timezone,
                   d.created_at,
                   d.updated_at
              FROM doctors d
              JOIN users u ON u.id = d.user_id
              JOIN profiles p ON p.user_id = d.user_id
              LEFT JOIN LATERAL (
                SELECT min(s.starts_at) AS next_available_at
                  FROM availability_slots s
                 WHERE s.doctor_id = d.user_id
                   AND s.status = 'available'
                   AND s.starts_at >= now()
              ) na ON true`;
  }

  private orderBy(sort: DoctorSort): string {
    switch (sort) {
      case 'fee_asc':
        return 'd.consultation_fee_cents ASC, d.user_id ASC';
      case 'fee_desc':
        return 'd.consultation_fee_cents DESC, d.user_id ASC';
      case 'next_available':
        return 'na.next_available_at ASC NULLS LAST, d.user_id ASC';
      case 'rating_desc':
      default:
        return 'd.rating DESC, d.rating_count DESC, d.user_id ASC';
    }
  }

  private toCursor(row: DoctorSummaryRow, sort: DoctorSort): DoctorCursor {
    switch (sort) {
      case 'fee_asc':
      case 'fee_desc':
        return { v: 1, sort, id: row.id, feeCents: row.consultation_fee_cents };
      case 'next_available':
        return {
          v: 1,
          sort,
          id: row.id,
          nextAvailableAt: row.next_available_at?.toISOString() ?? null,
        };
      case 'rating_desc':
      default:
        return {
          v: 1,
          sort,
          id: row.id,
          rating: row.rating,
          ratingCount: row.rating_count,
        };
    }
  }

  private money(row: DoctorSummaryRow): Money {
    return {
      amountCents: row.consultation_fee_cents,
      currency: row.currency.trim(),
    };
  }

  private toSummary(row: DoctorSummaryRow): DoctorSummary {
    return {
      id: row.id,
      fullName: row.full_name,
      specialization: row.specialization,
      subSpecialties: row.sub_specialties,
      languages: row.languages,
      yearsExperience: row.years_experience,
      consultationFee: this.money(row),
      city: row.city,
      rating: Number(row.rating),
      ratingCount: row.rating_count,
      acceptingNewPatients: row.accepting_new_patients,
      nextAvailableAt: row.next_available_at?.toISOString() ?? null,
      bio: row.bio,
    };
  }

  private toDetail(row: DoctorDetailRow): DoctorDetail {
    return {
      ...this.toSummary(row),
      licenseNumber: row.license_number,
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at?.toISOString() ?? null,
      timezone: row.timezone,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toAvailability(row: AvailabilityRow): AvailabilitySlot {
    return {
      id: row.id,
      doctorId: row.doctor_id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.status,
      durationMinutes: Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / 60_000),
    };
  }
}
