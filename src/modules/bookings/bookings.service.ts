import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../../common/idempotency/idempotency.service.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../common/security/tokens.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DoctorsService } from '../doctors/doctors.service.js';
import { decodeConsultationCursor, encodeConsultationCursor } from './bookings.cursor.js';
import type {
  CancelBookingInput,
  CompleteConsultationInput,
  CreateBookingInput,
  ListBookingsQuery,
  NoShowInput,
  RescheduleBookingInput,
} from './bookings.schemas.js';
import type {
  Consultation,
  ConsultationListResponse,
  JoinTokenResponse,
  PatientSummary,
} from './bookings.types.js';
import type { DoctorSummary } from '../doctors/doctors.types.js';

const JOIN_TOKEN_TTL_SECONDS = 600;

interface ConsultationLockRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  slot_id: string;
  status: Consultation['status'];
  scheduled_start: Date;
  scheduled_end: Date;
  fee_cents: number;
  currency: string;
  cancellation_reason: string | null;
}

interface BookableSlotRow {
  id: string;
  doctor_id: string;
  starts_at: Date;
  ends_at: Date;
  status: 'available' | 'held' | 'booked' | 'blocked';
  is_future: boolean;
  doctor_fee_cents: number;
  doctor_currency: string;
  verification_status: string;
  accepting_new_patients: boolean;
  doctor_status: string;
}

interface ConsultationRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  slot_id: string;
  status: Consultation['status'];
  scheduled_start: Date;
  scheduled_end: Date;
  fee_cents: number;
  consultation_currency: string;
  started_at: Date | null;
  ended_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  no_show_at: Date | null;
  diagnosis: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  patient_full_name: string;
  doctor_full_name: string;
  doctor_specialization: string;
  doctor_sub_specialties: string[];
  doctor_languages: string[];
  doctor_years_experience: number;
  doctor_fee_cents: number;
  doctor_currency: string;
  doctor_city: string | null;
  doctor_rating: string;
  doctor_rating_count: number;
  doctor_accepting_new_patients: boolean;
  doctor_next_available_at: Date | null;
  doctor_bio: string | null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly doctors: DoctorsService,
    private readonly config: AppConfigService,
  ) {}

  async create(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    input: CreateBookingInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Consultation>> {
    this.requireRole(user, ['patient']);

    const result = await this.idempotency.execute<Consultation>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: '/bookings',
        body: input,
        request,
      },
      async (client) => {
        await this.lockPatientForBooking(client, user.id);
        const slot = await this.lockBookableSlot(client, input.slotId);
        this.assertSlotBookable(slot);
        await this.assertNoPatientOverlap(client, user.id, slot.starts_at, slot.ends_at);

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO consultations (
             patient_id, doctor_id, slot_id, status, scheduled_start, scheduled_end,
             fee_cents, currency, notes
           ) VALUES ($1, $2, $3, 'scheduled', $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            user.id,
            slot.doctor_id,
            slot.id,
            slot.starts_at,
            slot.ends_at,
            slot.doctor_fee_cents,
            slot.doctor_currency.trim(),
            input.notes ?? null,
          ],
        );
        const consultationId = inserted.rows[0]?.id;
        if (!consultationId) {
          throw new Error('Failed to create consultation');
        }

        await this.markSlotBooked(client, slot.id);
        await client.query(
          `INSERT INTO consultation_slot_claims (slot_id, consultation_id)
           VALUES ($1, $2)`,
          [slot.id, consultationId],
        );

        const body = await this.loadConsultation(client, consultationId);

        await this.enqueue(client, consultationId, 'consultation.booked', {
          consultationId,
          patientId: user.id,
          doctorId: slot.doctor_id,
          slotId: slot.id,
          scheduledStart: slot.starts_at.toISOString(),
          scheduledEnd: slot.ends_at.toISOString(),
          feeCents: slot.doctor_fee_cents,
          currency: slot.doctor_currency.trim(),
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'consultation.booked',
            resourceType: 'consultation',
            resourceId: consultationId,
            request,
            after: {
              status: 'scheduled',
              slotId: slot.id,
              scheduledStart: slot.starts_at.toISOString(),
              scheduledEnd: slot.ends_at.toISOString(),
            },
            metadata: {
              doctorId: slot.doctor_id,
              feeCents: slot.doctor_fee_cents,
            },
          },
          client,
        );

        return { status: HttpStatus.CREATED, body };
      },
    );

    if (!result.replayed) {
      await this.doctors.invalidateDoctor(result.body.doctorId);
    }

    return result;
  }

  async list(user: AuthenticatedUser, query: ListBookingsQuery): Promise<ConsultationListResponse> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (user.role === 'patient') {
      values.push(user.id);
      conditions.push(`c.patient_id = $${values.length}`);
    } else if (user.role === 'doctor') {
      values.push(user.id);
      conditions.push(`c.doctor_id = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      conditions.push(`c.status = $${values.length}::consultation_status`);
    }

    if (query.from) {
      values.push(query.from);
      conditions.push(`c.scheduled_start >= $${values.length}`);
    }

    if (query.to) {
      values.push(query.to);
      conditions.push(`c.scheduled_start < $${values.length}`);
    }

    if (query.cursor) {
      const cursor = decodeConsultationCursor(query.cursor);
      values.push(new Date(cursor.scheduledStart));
      const startParameter = `$${values.length}`;
      values.push(cursor.id);
      const idParameter = `$${values.length}`;
      conditions.push(
        `(c.scheduled_start < ${startParameter}::timestamptz ` +
          `OR (c.scheduled_start = ${startParameter}::timestamptz ` +
          `AND c.id < ${idParameter}::uuid))`,
      );
    }

    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.database.query<ConsultationRow>(
      `${this.consultationSelect()}
        ${where}
        ORDER BY c.scheduled_start DESC, c.id DESC
        LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toConsultation(row)),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeConsultationCursor({
                v: 1,
                scheduledStart: last.scheduled_start.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  async get(user: AuthenticatedUser, consultationId: string): Promise<Consultation> {
    const consultation = await this.loadConsultation(null, consultationId);
    this.assertCanView(user, {
      patient_id: consultation.patientId,
      doctor_id: consultation.doctorId,
    });

    return consultation;
  }

  async cancel(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    input: CancelBookingInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Consultation>> {
    this.requireRole(user, ['patient', 'admin']);

    const result = await this.idempotency.execute<Consultation>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/cancel`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockConsultation(client, consultationId);
        this.assertCanCancel(user, current);

        if (
          current.status === 'completed' ||
          current.status === 'cancelled' ||
          current.status === 'no_show'
        ) {
          throw this.invalidTransition('Terminal consultations cannot be cancelled');
        }

        await client.query(
          `UPDATE consultations
              SET status = 'cancelled',
                  cancelled_at = now(),
                  cancelled_by_user_id = $2,
                  cancellation_reason = $3,
                  join_token_hash = NULL,
                  join_token_expires_at = NULL
            WHERE id = $1`,
          [consultationId, user.id, input.reason],
        );

        await this.releaseSlot(client, current.slot_id, current.id);
        const body = await this.loadConsultation(client, consultationId);

        await this.enqueue(client, consultationId, 'consultation.cancelled', {
          consultationId,
          cancelledBy: user.id,
          cancelledByRole: user.role,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'consultation.cancelled',
            resourceType: 'consultation',
            resourceId: consultationId,
            request,
            before: this.auditState(current),
            after: {
              status: 'cancelled',
              slotId: current.slot_id,
              scheduledStart: current.scheduled_start.toISOString(),
              scheduledEnd: current.scheduled_end.toISOString(),
            },
            metadata: { cancelledByRole: user.role },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    if (!result.replayed) {
      await this.doctors.invalidateDoctor(result.body.doctorId);
    }

    return result;
  }

  async reschedule(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    input: RescheduleBookingInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Consultation>> {
    this.requireRole(user, ['patient', 'admin']);

    const result = await this.idempotency.execute<Consultation>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/reschedule`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockConsultation(client, consultationId);
        this.assertCanManageBooking(user, current);

        if (current.status !== 'scheduled') {
          throw this.invalidTransition('Only scheduled consultations can be rescheduled');
        }

        if (input.slotId === current.slot_id) {
          throw new ApiException(HttpStatus.CONFLICT, {
            code: ErrorCodes.SLOT_UNAVAILABLE,
            message: 'The consultation is already assigned to this slot',
          });
        }

        await this.lockPatientForBooking(client, current.patient_id);
        const slot = await this.lockBookableSlot(client, input.slotId);
        this.assertSlotBookable(slot);

        if (slot.doctor_id !== current.doctor_id) {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.UNPROCESSABLE_ENTITY,
            message: 'A consultation can only be rescheduled with the same doctor',
          });
        }

        await this.assertNoPatientOverlap(
          client,
          current.patient_id,
          slot.starts_at,
          slot.ends_at,
          current.id,
        );

        await client.query(
          `UPDATE consultations
              SET slot_id = $2,
                  scheduled_start = $3,
                  scheduled_end = $4,
                  join_token_hash = NULL,
                  join_token_expires_at = NULL
            WHERE id = $1`,
          [consultationId, slot.id, slot.starts_at, slot.ends_at],
        );

        await client.query('DELETE FROM consultation_slot_claims WHERE consultation_id = $1', [
          consultationId,
        ]);
        await client.query(
          `INSERT INTO consultation_slot_claims (slot_id, consultation_id)
           VALUES ($1, $2)`,
          [slot.id, consultationId],
        );
        await this.markSlotBooked(client, slot.id);
        await this.releaseBookedSlot(client, current.slot_id);

        const body = await this.loadConsultation(client, consultationId);

        await this.enqueue(client, consultationId, 'consultation.rescheduled', {
          consultationId,
          previousSlotId: current.slot_id,
          previousStart: current.scheduled_start.toISOString(),
          previousEnd: current.scheduled_end.toISOString(),
          slotId: slot.id,
          scheduledStart: slot.starts_at.toISOString(),
          scheduledEnd: slot.ends_at.toISOString(),
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'consultation.rescheduled',
            resourceType: 'consultation',
            resourceId: consultationId,
            request,
            before: this.auditState(current),
            after: {
              status: current.status,
              slotId: slot.id,
              scheduledStart: slot.starts_at.toISOString(),
              scheduledEnd: slot.ends_at.toISOString(),
            },
            metadata: { previousSlotId: current.slot_id, newSlotId: slot.id },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    if (!result.replayed) {
      await this.doctors.invalidateDoctor(result.body.doctorId);
    }

    return result;
  }

  async start(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Consultation>> {
    this.requireRole(user, ['doctor']);

    const result = await this.idempotency.execute<Consultation>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/start`,
        body: {},
        request,
      },
      async (client) => {
        const current = await this.lockConsultation(client, consultationId);
        this.assertAssignedDoctor(user, current);

        if (current.status !== 'scheduled') {
          throw this.invalidTransition('Only scheduled consultations can be started');
        }

        await client.query(
          `UPDATE consultations
              SET status = 'in_progress', started_at = now()
            WHERE id = $1`,
          [consultationId],
        );

        const body = await this.loadConsultation(client, consultationId);

        await this.enqueue(client, consultationId, 'consultation.started', {
          consultationId,
          doctorId: current.doctor_id,
          startedAt: body.startedAt,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'consultation.started',
            resourceType: 'consultation',
            resourceId: consultationId,
            request,
            before: this.auditState(current),
            after: { status: 'in_progress' },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    return result;
  }

  async complete(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    input: CompleteConsultationInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Consultation>> {
    this.requireRole(user, ['doctor']);

    const result = await this.idempotency.execute<Consultation>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/complete`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockConsultation(client, consultationId);
        this.assertAssignedDoctor(user, current);

        if (current.status !== 'in_progress') {
          throw this.invalidTransition('Only in-progress consultations can be completed');
        }

        await client.query(
          `UPDATE consultations
              SET status = 'completed',
                  ended_at = now(),
                  diagnosis = COALESCE($2, diagnosis),
                  notes = COALESCE($3, notes),
                  join_token_hash = NULL,
                  join_token_expires_at = NULL
            WHERE id = $1`,
          [consultationId, input.diagnosis ?? null, input.notes ?? null],
        );

        const body = await this.loadConsultation(client, consultationId);

        await this.enqueue(client, consultationId, 'consultation.completed', {
          consultationId,
          doctorId: current.doctor_id,
          endedAt: body.endedAt,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'consultation.completed',
            resourceType: 'consultation',
            resourceId: consultationId,
            request,
            before: this.auditState(current),
            after: { status: 'completed' },
            metadata: {
              diagnosisRecorded: Boolean(input.diagnosis),
              notesRecorded: Boolean(input.notes),
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    return result;
  }

  async noShow(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    input: NoShowInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Consultation>> {
    this.requireRole(user, ['doctor', 'admin']);

    const result = await this.idempotency.execute<Consultation>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/no-show`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockConsultation(client, consultationId);

        if (user.role === 'doctor') {
          this.assertAssignedDoctor(user, current);
        }

        if (current.status !== 'scheduled') {
          throw this.invalidTransition('Only scheduled consultations can be marked no-show');
        }

        await client.query(
          `UPDATE consultations
              SET status = 'no_show',
                  no_show_at = now(),
                  no_show_notes = $2,
                  join_token_hash = NULL,
                  join_token_expires_at = NULL
            WHERE id = $1`,
          [consultationId, input.notes ?? null],
        );

        await this.releaseSlot(client, current.slot_id, current.id);
        const body = await this.loadConsultation(client, consultationId);

        await this.enqueue(client, consultationId, 'consultation.no_show', {
          consultationId,
          markedBy: user.id,
          markedByRole: user.role,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'consultation.no_show',
            resourceType: 'consultation',
            resourceId: consultationId,
            request,
            before: this.auditState(current),
            after: { status: 'no_show' },
            metadata: { notesRecorded: Boolean(input.notes) },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );

    if (!result.replayed) {
      await this.doctors.invalidateDoctor(result.body.doctorId);
    }

    return result;
  }

  async createJoinToken(
    user: AuthenticatedUser,
    consultationId: string,
    request: RequestMetadata,
  ): Promise<JoinTokenResponse> {
    this.requireRole(user, ['patient', 'doctor']);

    return this.database.withTransaction(async (client) => {
      const current = await this.lockConsultation(client, consultationId);
      this.assertCanView(user, current);

      if (current.status !== 'scheduled' && current.status !== 'in_progress') {
        throw new ApiException(HttpStatus.CONFLICT, {
          code: ErrorCodes.JOIN_TOKEN_UNAVAILABLE,
          message: 'Join tokens are only available for active consultations',
        });
      }

      const token = generateOpaqueToken();
      const tokenHash = hashOpaqueToken(token, this.config.auth.secrets.tokenPepper);
      const expiresAt = new Date(Date.now() + JOIN_TOKEN_TTL_SECONDS * 1_000);

      await client.query(
        `UPDATE consultations
            SET join_token_hash = $2, join_token_expires_at = $3
          WHERE id = $1`,
        [consultationId, tokenHash, expiresAt],
      );

      const joinUrl = new URL(
        `/consultations/${consultationId}/join`,
        this.config.service.publicUrl,
      );
      joinUrl.searchParams.set('token', token);

      await this.audit.record(
        {
          actorId: user.id,
          actorRole: user.role,
          action: 'consultation.join_token_issued',
          resourceType: 'consultation',
          resourceId: consultationId,
          request,
          metadata: { expiresAt: expiresAt.toISOString() },
        },
        client,
      );

      return { token, expiresAt: expiresAt.toISOString(), joinUrl: joinUrl.toString() };
    });
  }

  private consultationSelect(): string {
    return `SELECT c.id,
                   c.patient_id,
                   c.doctor_id,
                   c.slot_id,
                   c.status,
                   c.scheduled_start,
                   c.scheduled_end,
                   c.fee_cents,
                   c.currency AS consultation_currency,
                   c.started_at,
                   c.ended_at,
                   c.cancelled_at,
                   c.cancellation_reason,
                   c.no_show_at,
                   c.diagnosis,
                   c.notes,
                   c.created_at,
                   c.updated_at,
                   pp.full_name AS patient_full_name,
                   dp.full_name AS doctor_full_name,
                   d.specialization AS doctor_specialization,
                   d.sub_specialties AS doctor_sub_specialties,
                   d.languages AS doctor_languages,
                   d.years_experience AS doctor_years_experience,
                   d.consultation_fee_cents AS doctor_fee_cents,
                   d.currency AS doctor_currency,
                   d.city AS doctor_city,
                   d.rating AS doctor_rating,
                   d.rating_count AS doctor_rating_count,
                   d.accepting_new_patients AS doctor_accepting_new_patients,
                   na.next_available_at AS doctor_next_available_at,
                   d.bio AS doctor_bio
              FROM consultations c
              JOIN profiles pp ON pp.user_id = c.patient_id
              JOIN profiles dp ON dp.user_id = c.doctor_id
              JOIN doctors d ON d.user_id = c.doctor_id
              LEFT JOIN LATERAL (
                SELECT min(s.starts_at) AS next_available_at
                  FROM availability_slots s
                 WHERE s.doctor_id = d.user_id
                   AND s.status = 'available'
                   AND s.starts_at >= now()
              ) na ON true`;
  }

  private async loadConsultation(
    client: PoolClient | null,
    consultationId: string,
  ): Promise<Consultation> {
    const sql = `${this.consultationSelect()} WHERE c.id = $1`;
    const result = client
      ? await client.query<ConsultationRow>(sql, [consultationId])
      : await this.database.query<ConsultationRow>(sql, [consultationId]);
    const row = result.rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Consultation not found',
      });
    }

    return this.toConsultation(row);
  }

  private async lockConsultation(
    client: PoolClient,
    consultationId: string,
  ): Promise<ConsultationLockRow> {
    const { rows } = await client.query<ConsultationLockRow>(
      `SELECT id, patient_id, doctor_id, slot_id, status, scheduled_start,
              scheduled_end, fee_cents, currency, cancellation_reason
         FROM consultations
        WHERE id = $1
        FOR UPDATE`,
      [consultationId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Consultation not found',
      });
    }

    return row;
  }

  private async lockBookableSlot(client: PoolClient, slotId: string): Promise<BookableSlotRow> {
    const { rows } = await client.query<BookableSlotRow>(
      `SELECT s.id,
              s.doctor_id,
              s.starts_at,
              s.ends_at,
              s.status,
              s.starts_at > now() AS is_future,
              d.consultation_fee_cents AS doctor_fee_cents,
              d.currency AS doctor_currency,
              d.verification_status,
              d.accepting_new_patients,
              u.status AS doctor_status
         FROM availability_slots s
         JOIN doctors d ON d.user_id = s.doctor_id
         JOIN users u ON u.id = d.user_id
        WHERE s.id = $1
        FOR UPDATE OF s`,
      [slotId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Availability slot not found',
      });
    }

    return row;
  }

  private assertSlotBookable(slot: BookableSlotRow): void {
    if (slot.status !== 'available' || !slot.is_future) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.SLOT_UNAVAILABLE,
        message: 'This slot is no longer available',
      });
    }

    if (
      slot.verification_status !== 'verified' ||
      slot.doctor_status !== 'active' ||
      !slot.accepting_new_patients
    ) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.DOCTOR_NOT_ACCEPTING_PATIENTS,
        message: 'This doctor is not currently accepting new bookings',
      });
    }
  }

  private async markSlotBooked(client: PoolClient, slotId: string): Promise<void> {
    await client.query(
      `UPDATE availability_slots
          SET status = 'booked', hold_expires_at = NULL
        WHERE id = $1`,
      [slotId],
    );
  }

  private async releaseBookedSlot(client: PoolClient, slotId: string): Promise<void> {
    await client.query(
      `UPDATE availability_slots
          SET status = CASE
                WHEN starts_at > now() THEN 'available'::slot_status
                ELSE 'blocked'::slot_status
              END,
              hold_expires_at = NULL
        WHERE id = $1 AND status = 'booked'`,
      [slotId],
    );
  }

  private async releaseSlot(
    client: PoolClient,
    slotId: string,
    consultationId: string,
  ): Promise<void> {
    await client.query('DELETE FROM consultation_slot_claims WHERE consultation_id = $1', [
      consultationId,
    ]);
    await this.releaseBookedSlot(client, slotId);
  }

  private async lockPatientForBooking(client: PoolClient, patientId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
      `consultation-patient:${patientId}`,
    ]);
  }

  private async assertNoPatientOverlap(
    client: PoolClient,
    patientId: string,
    startsAt: Date,
    endsAt: Date,
    excludeConsultationId?: string,
  ): Promise<void> {
    const values: unknown[] = [patientId, startsAt, endsAt];
    let exclusion = '';

    if (excludeConsultationId) {
      values.push(excludeConsultationId);
      exclusion = `AND id <> $${values.length}::uuid`;
    }

    const { rows } = await client.query<{ id: string }>(
      `SELECT id
         FROM consultations
        WHERE patient_id = $1
          AND status IN ('scheduled', 'in_progress')
          AND scheduled_start < $3
          AND scheduled_end > $2
          ${exclusion}
        LIMIT 1`,
      values,
    );

    if (rows[0]) {
      throw new ApiException(HttpStatus.CONFLICT, {
        code: ErrorCodes.CONSULTATION_OVERLAP,
        message: 'The patient already has a consultation during this time',
      });
    }
  }

  private async enqueue(
    client: PoolClient,
    consultationId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('consultation', $1, $2, $3::jsonb)`,
      [consultationId, eventType, JSON.stringify(payload)],
    );
  }

  private auditState(row: ConsultationLockRow): Record<string, unknown> {
    return {
      status: row.status,
      slotId: row.slot_id,
      scheduledStart: row.scheduled_start.toISOString(),
      scheduledEnd: row.scheduled_end.toISOString(),
    };
  }

  private assertCanView(
    user: AuthenticatedUser,
    consultation: { patient_id: string; doctor_id: string },
  ): void {
    if (user.role === 'admin') {
      return;
    }

    if (user.role === 'patient' && consultation.patient_id === user.id) {
      return;
    }

    if (user.role === 'doctor' && consultation.doctor_id === user.id) {
      return;
    }

    throw new ApiException(HttpStatus.FORBIDDEN, {
      code: ErrorCodes.FORBIDDEN,
      message: 'You do not have permission to access this consultation',
    });
  }

  private assertCanManageBooking(user: AuthenticatedUser, consultation: ConsultationLockRow): void {
    if (user.role === 'admin') {
      return;
    }

    if (user.role === 'patient' && consultation.patient_id === user.id) {
      return;
    }

    throw new ApiException(HttpStatus.FORBIDDEN, {
      code: ErrorCodes.FORBIDDEN,
      message: 'You do not have permission to change this consultation',
    });
  }

  private assertCanCancel(user: AuthenticatedUser, consultation: ConsultationLockRow): void {
    this.assertCanManageBooking(user, consultation);
  }

  private assertAssignedDoctor(user: AuthenticatedUser, consultation: ConsultationLockRow): void {
    if (user.role !== 'doctor' || consultation.doctor_id !== user.id) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'Only the assigned doctor can perform this action',
      });
    }
  }

  private requireRole(user: AuthenticatedUser, roles: AuthenticatedUser['role'][]): void {
    if (!roles.includes(user.role)) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'You do not have permission to perform this action',
      });
    }
  }

  private invalidTransition(message: string): ApiException {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: ErrorCodes.INVALID_STATE_TRANSITION,
      message,
    });
  }

  private toConsultation(row: ConsultationRow): Consultation {
    const patient: PatientSummary = {
      id: row.patient_id,
      fullName: row.patient_full_name,
    };
    const doctor: DoctorSummary = {
      id: row.doctor_id,
      fullName: row.doctor_full_name,
      specialization: row.doctor_specialization,
      subSpecialties: row.doctor_sub_specialties,
      languages: row.doctor_languages,
      yearsExperience: row.doctor_years_experience,
      consultationFee: {
        amountCents: row.doctor_fee_cents,
        currency: row.doctor_currency.trim(),
      },
      city: row.doctor_city,
      rating: Number(row.doctor_rating),
      ratingCount: row.doctor_rating_count,
      acceptingNewPatients: row.doctor_accepting_new_patients,
      nextAvailableAt: iso(row.doctor_next_available_at),
      bio: row.doctor_bio,
    };

    return {
      id: row.id,
      patientId: row.patient_id,
      doctorId: row.doctor_id,
      slotId: row.slot_id,
      status: row.status,
      scheduledStart: row.scheduled_start.toISOString(),
      scheduledEnd: row.scheduled_end.toISOString(),
      fee: {
        amountCents: row.fee_cents,
        currency: row.consultation_currency.trim(),
      },
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
      cancelledAt: iso(row.cancelled_at),
      cancellationReason: row.cancellation_reason,
      noShowAt: iso(row.no_show_at),
      diagnosis: row.diagnosis,
      notes: row.notes,
      patient,
      doctor,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
