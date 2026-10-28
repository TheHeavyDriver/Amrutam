import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../../common/idempotency/idempotency.service.js';
import type { DoctorDetail, DoctorDetailListResponse } from '../doctors/doctors.types.js';
import { CacheService } from '../../cache/cache.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { decodeAdminDoctorCursor, encodeAdminDoctorCursor } from './admin-doctors.cursor.js';
import type {
  AdminDoctorListQuery,
  DoctorVerificationInput,
  DoctorVerificationStatus,
} from './admin-doctors.schemas.js';

interface AdminDoctorRow {
  user_id: string;
  full_name: string;
  specialization: string;
  sub_specialties: string[];
  languages: string[];
  years_experience: number;
  consultation_fee_cents: number;
  currency: string;
  city: string | null;
  rating: string | number;
  rating_count: number;
  accepting_new_patients: boolean;
  next_available_at: Date | null;
  bio: string | null;
  license_number: string;
  verification_status: DoctorVerificationStatus;
  verified_at: Date | null;
  timezone: string;
  created_at: Date;
  created_at_text: string;
  updated_at: Date;
}

interface LockedDoctorRow {
  user_id: string;
  verification_status: DoctorVerificationStatus;
}

@Injectable()
export class AdminDoctorsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async list(query: AdminDoctorListQuery): Promise<DoctorDetailListResponse> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.verificationStatus) {
      values.push(query.verificationStatus);
      conditions.push(`d.verification_status = $${values.length}::doctor_verification_status`);
    }

    if (query.cursor) {
      const cursor = decodeAdminDoctorCursor(query.cursor);
      // Keep the database's microsecond precision. Converting to a JavaScript
      // Date would truncate to milliseconds and skip rows sharing a timestamp.
      values.push(cursor.createdAt);
      const createdAtParameter = `$${values.length}`;
      values.push(cursor.id);
      const idParameter = `$${values.length}`;
      conditions.push(
        `(d.created_at < ${createdAtParameter}::timestamptz ` +
          `OR (d.created_at = ${createdAtParameter}::timestamptz ` +
          `AND d.user_id < ${idParameter}::uuid))`,
      );
    }

    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.database.query<AdminDoctorRow>(
      `${this.detailSelect()}
       ${where}
       ORDER BY d.created_at DESC, d.user_id DESC
       LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toDetail(row)),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeAdminDoctorCursor({
                v: 1,
                createdAt: last.created_at_text,
                id: last.user_id,
              })
            : null,
      },
    };
  }

  async updateVerification(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    doctorId: string,
    input: DoctorVerificationInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<DoctorDetail>> {
    const result = await this.idempotency.execute<DoctorDetail>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'PATCH',
        path: `/admin/doctors/${doctorId}/verification`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockDoctor(client, doctorId);

        if (current.verification_status === input.status) {
          return {
            status: HttpStatus.OK,
            body: await this.loadDetail(client, doctorId),
          };
        }

        await client.query(
          `UPDATE doctors
              SET verification_status = $2::doctor_verification_status,
                  verified_at = CASE
                    WHEN $2 = 'verified' THEN now()
                    WHEN $2 = 'suspended' THEN COALESCE(verified_at, now())
                    ELSE NULL
                  END,
                  verified_by = $3,
                  verification_reason = $4,
                  accepting_new_patients = ($2 = 'verified')
            WHERE user_id = $1`,
          [doctorId, input.status, user.id, input.reason ?? null],
        );

        if (input.status !== 'verified') {
          await client.query(
            `UPDATE auth_sessions
                SET revoked_at = now(),
                    revoked_reason = $2
              WHERE user_id = $1
                AND revoked_at IS NULL`,
            [doctorId, `doctor_verification_${input.status}`],
          );
        }

        const body = await this.loadDetail(client, doctorId);

        await client.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('doctor', $1, 'doctor.verification_updated', $2::jsonb)`,
          [
            doctorId,
            JSON.stringify({
              doctorId,
              verificationStatus: input.status,
              reviewedBy: user.id,
            }),
          ],
        );

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'doctor.verification_updated',
            resourceType: 'doctor',
            resourceId: doctorId,
            request,
            before: {
              verificationStatus: current.verification_status,
            },
            after: {
              verificationStatus: input.status,
            },
            metadata: {
              doctorId,
              reasonProvided: Boolean(input.reason),
              reviewerRole: user.role,
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    await this.cache.deleteByPrefix('amrutam:v1:doctors:');
    return result;
  }

  private detailSelect(): string {
    return `SELECT d.user_id,
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
                   next_slot.next_available_at,
                   d.bio,
                   d.license_number,
                   d.verification_status,
                   d.verified_at,
                   d.timezone,
                   d.created_at,
                   to_char(
                     d.created_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                   ) AS created_at_text,
                   d.updated_at
              FROM doctors d
              JOIN users u ON u.id = d.user_id
              JOIN profiles p ON p.user_id = d.user_id
              LEFT JOIN LATERAL (
                SELECT min(s.starts_at) AS next_available_at
                  FROM availability_slots s
                 WHERE s.doctor_id = d.user_id
                   AND s.status = 'available'
                   AND s.starts_at > now()
              ) next_slot ON true`;
  }

  private async lockDoctor(client: PoolClient, doctorId: string): Promise<LockedDoctorRow> {
    const { rows } = await client.query<LockedDoctorRow>(
      `SELECT user_id, verification_status
         FROM doctors
        WHERE user_id = $1
        FOR UPDATE`,
      [doctorId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Doctor not found',
      });
    }

    return row;
  }

  private async loadDetail(client: PoolClient | null, doctorId: string): Promise<DoctorDetail> {
    const sql = `${this.detailSelect()} WHERE d.user_id = $1`;
    const result = client
      ? await client.query<AdminDoctorRow>(sql, [doctorId])
      : await this.database.query<AdminDoctorRow>(sql, [doctorId]);
    const row = result.rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Doctor not found',
      });
    }

    return this.toDetail(row);
  }

  private toDetail(row: AdminDoctorRow): DoctorDetail {
    return {
      id: row.user_id,
      fullName: row.full_name,
      specialization: row.specialization,
      subSpecialties: row.sub_specialties,
      languages: row.languages,
      yearsExperience: row.years_experience,
      consultationFee: {
        amountCents: row.consultation_fee_cents,
        currency: row.currency.trim(),
      },
      city: row.city,
      rating: Number(row.rating),
      ratingCount: row.rating_count,
      acceptingNewPatients: row.accepting_new_patients,
      nextAvailableAt: row.next_available_at?.toISOString() ?? null,
      bio: row.bio,
      licenseNumber: row.license_number,
      verificationStatus: row.verification_status,
      verifiedAt: row.verified_at?.toISOString() ?? null,
      timezone: row.timezone,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
