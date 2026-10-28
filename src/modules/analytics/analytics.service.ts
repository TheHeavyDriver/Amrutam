import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import { DatabaseService } from '../../database/database.service.js';
import type {
  AnalyticsInterval,
  AnalyticsOverview,
  AnalyticsRange,
  ConsultationBucket,
  ConsultationsAnalytics,
  DoctorUtilization,
  DoctorUtilizationResponse,
  RevenueAnalytics,
  RevenueBucket,
  SpecialtyAnalyticsResponse,
  SpecialtyMetric,
} from './analytics.types.js';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;

interface ResolvedRange {
  from: Date;
  to: Date;
  response: AnalyticsRange;
}

interface OverviewRow {
  total: number;
  completed: number;
  cancelled: number;
  no_show: number;
  captured_cents: string;
  refunded_cents: string;
  doctors_active: number;
  doctors_verified: number;
  patients_total: number;
  patients_new: number;
  currency: string;
}

interface ConsultationBucketRow {
  bucket_start: Date;
  total: number;
  completed: number;
  cancelled: number;
  no_show: number;
}

interface RevenueBucketRow {
  bucket_start: Date;
  captured_cents: string;
  refunded_cents: string;
}

interface DoctorUtilizationRow {
  doctor_id: string;
  full_name: string;
  specialization: string;
  available_slots: number;
  booked_slots: number;
  completed_consultations: number;
}

interface SpecialtyRow {
  specialization: string;
  consultations: number;
  revenue_cents: string;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly database: DatabaseService) {}

  async overview(fromInput?: Date, toInput?: Date): Promise<AnalyticsOverview> {
    const range = this.resolveRange(fromInput, toInput);

    const { rows } = await this.database.query<OverviewRow>(
      `SELECT
         (SELECT count(*)::int FROM consultations
           WHERE scheduled_start >= $1 AND scheduled_start < $2) AS total,
         (SELECT count(*)::int FROM consultations
           WHERE scheduled_start >= $1 AND scheduled_start < $2
             AND status = 'completed') AS completed,
         (SELECT count(*)::int FROM consultations
           WHERE scheduled_start >= $1 AND scheduled_start < $2
             AND status = 'cancelled') AS cancelled,
         (SELECT count(*)::int FROM consultations
           WHERE scheduled_start >= $1 AND scheduled_start < $2
             AND status = 'no_show') AS no_show,
         (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM payments
           WHERE captured_at >= $1 AND captured_at < $2
             AND status IN ('captured', 'partially_refunded', 'refunded')) AS captured_cents,
         (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM payment_refunds
           WHERE created_at >= $1 AND created_at < $2) AS refunded_cents,
         (SELECT count(*)::int
            FROM users u
           WHERE u.role = 'doctor' AND u.status = 'active') AS doctors_active,
         (SELECT count(*)::int
            FROM doctors d
            JOIN users u ON u.id = d.user_id
           WHERE d.verification_status = 'verified'
             AND u.status = 'active') AS doctors_verified,
         (SELECT count(*)::int
            FROM users u
           WHERE u.role = 'patient' AND u.status = 'active') AS patients_total,
         (SELECT count(*)::int
            FROM users u
           WHERE u.role = 'patient' AND u.status = 'active'
             AND u.created_at >= $1 AND u.created_at < $2) AS patients_new,
         COALESCE(
           (SELECT p.currency
              FROM payments p
             WHERE p.captured_at >= $1 AND p.captured_at < $2
             ORDER BY p.captured_at DESC
             LIMIT 1),
           (SELECT d.currency FROM doctors d ORDER BY d.user_id LIMIT 1),
           'INR'
         ) AS currency`,
      [range.from, range.to],
    );
    const row = rows[0];

    if (!row) {
      throw new Error('Failed to calculate analytics overview');
    }

    const total = row.total;
    const capturedCents = Number(row.captured_cents);
    const refundedCents = Number(row.refunded_cents);

    return {
      range: range.response,
      consultations: {
        total,
        completed: row.completed,
        cancelled: row.cancelled,
        noShow: row.no_show,
        completionRate: total === 0 ? 0 : Number((row.completed / total).toFixed(4)),
      },
      revenue: {
        capturedCents,
        refundedCents,
        netCents: capturedCents - refundedCents,
        currency: row.currency.trim(),
      },
      doctors: {
        active: row.doctors_active,
        verified: row.doctors_verified,
      },
      patients: {
        total: row.patients_total,
        new: row.patients_new,
      },
    };
  }

  async consultations(
    interval: AnalyticsInterval,
    fromInput?: Date,
    toInput?: Date,
  ): Promise<ConsultationsAnalytics> {
    const range = this.resolveRange(fromInput, toInput);
    const { rows } = await this.database.query<ConsultationBucketRow>(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc('${interval}', $1::timestamptz, 'UTC'),
           date_trunc('${interval}', ($2::timestamptz - interval '1 millisecond'), 'UTC'),
           interval '1 ${interval}'
         ) AS bucket_start
       )
       SELECT b.bucket_start,
              count(c.id)::int AS total,
              count(c.id) FILTER (WHERE c.status = 'completed')::int AS completed,
              count(c.id) FILTER (WHERE c.status = 'cancelled')::int AS cancelled,
              count(c.id) FILTER (WHERE c.status = 'no_show')::int AS no_show
         FROM buckets b
         LEFT JOIN consultations c
           ON date_trunc('${interval}', c.scheduled_start, 'UTC') = b.bucket_start
          AND c.scheduled_start >= $1
          AND c.scheduled_start < $2
        GROUP BY b.bucket_start
        ORDER BY b.bucket_start ASC`,
      [range.from, range.to],
    );

    return {
      range: range.response,
      interval,
      buckets: rows.map((row): ConsultationBucket => ({
        bucketStart: row.bucket_start.toISOString(),
        total: row.total,
        completed: row.completed,
        cancelled: row.cancelled,
        noShow: row.no_show,
      })),
    };
  }

  async revenue(
    interval: AnalyticsInterval,
    fromInput?: Date,
    toInput?: Date,
  ): Promise<RevenueAnalytics> {
    const range = this.resolveRange(fromInput, toInput);
    const { rows } = await this.database.query<RevenueBucketRow>(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc('${interval}', $1::timestamptz, 'UTC'),
           date_trunc('${interval}', ($2::timestamptz - interval '1 millisecond'), 'UTC'),
           interval '1 ${interval}'
         ) AS bucket_start
       ),
       captured AS (
         SELECT date_trunc('${interval}', captured_at, 'UTC') AS bucket_start,
                sum(amount_cents)::bigint AS amount_cents
           FROM payments
          WHERE captured_at >= $1 AND captured_at < $2
            AND status IN ('captured', 'partially_refunded', 'refunded')
          GROUP BY 1
       ),
       refunded AS (
         SELECT date_trunc('${interval}', created_at, 'UTC') AS bucket_start,
                sum(amount_cents)::bigint AS amount_cents
           FROM payment_refunds
          WHERE created_at >= $1 AND created_at < $2
          GROUP BY 1
       )
       SELECT b.bucket_start,
              COALESCE(c.amount_cents, 0)::bigint AS captured_cents,
              COALESCE(r.amount_cents, 0)::bigint AS refunded_cents
         FROM buckets b
         LEFT JOIN captured c ON c.bucket_start = b.bucket_start
         LEFT JOIN refunded r ON r.bucket_start = b.bucket_start
        ORDER BY b.bucket_start ASC`,
      [range.from, range.to],
    );

    const currencyResult = await this.database.query<{ currency: string }>(
      `SELECT COALESCE(
         (SELECT p.currency FROM payments p
           WHERE p.captured_at >= $1 AND p.captured_at < $2
           ORDER BY p.captured_at DESC LIMIT 1),
         (SELECT d.currency FROM doctors d ORDER BY d.user_id LIMIT 1),
         'INR'
       ) AS currency`,
      [range.from, range.to],
    );

    return {
      range: range.response,
      interval,
      currency: currencyResult.rows[0]?.currency.trim() ?? 'INR',
      buckets: rows.map((row): RevenueBucket => {
        const capturedCents = Number(row.captured_cents);
        const refundedCents = Number(row.refunded_cents);
        return {
          bucketStart: row.bucket_start.toISOString(),
          capturedCents,
          refundedCents,
          netCents: capturedCents - refundedCents,
        };
      }),
    };
  }

  async doctorUtilization(
    fromInput?: Date,
    toInput?: Date,
    doctorId?: string,
  ): Promise<DoctorUtilizationResponse> {
    const range = this.resolveRange(fromInput, toInput);
    const values: unknown[] = [range.from, range.to];
    let doctorFilter = '';

    if (doctorId) {
      values.push(doctorId);
      doctorFilter = `AND d.user_id = $${values.length}::uuid`;
    }

    const { rows } = await this.database.query<DoctorUtilizationRow>(
      `SELECT d.user_id AS doctor_id,
              p.full_name,
              d.specialization,
              COALESCE(s.available_slots, 0)::int AS available_slots,
              COALESCE(s.booked_slots, 0)::int AS booked_slots,
              COALESCE(c.completed_consultations, 0)::int AS completed_consultations
         FROM doctors d
         JOIN users u ON u.id = d.user_id
         JOIN profiles p ON p.user_id = d.user_id
         LEFT JOIN (
           SELECT doctor_id,
                  count(*) FILTER (WHERE status = 'available')::int AS available_slots,
                  count(*) FILTER (WHERE status = 'booked')::int AS booked_slots
             FROM availability_slots
            WHERE starts_at >= $1 AND starts_at < $2
            GROUP BY doctor_id
         ) s ON s.doctor_id = d.user_id
         LEFT JOIN (
           SELECT doctor_id, count(*)::int AS completed_consultations
             FROM consultations
            WHERE scheduled_start >= $1 AND scheduled_start < $2
              AND status = 'completed'
            GROUP BY doctor_id
         ) c ON c.doctor_id = d.user_id
        WHERE u.role = 'doctor'
          AND u.status = 'active'
          ${doctorFilter}
        ORDER BY p.full_name ASC`,
      values,
    );

    return {
      range: range.response,
      data: rows.map((row): DoctorUtilization => {
        const capacity = row.available_slots + row.booked_slots;
        return {
          doctorId: row.doctor_id,
          fullName: row.full_name,
          specialization: row.specialization,
          availableSlots: row.available_slots,
          bookedSlots: row.booked_slots,
          completedConsultations: row.completed_consultations,
          utilizationRate: capacity === 0 ? 0 : Number((row.booked_slots / capacity).toFixed(4)),
        };
      }),
    };
  }

  async specialties(fromInput?: Date, toInput?: Date): Promise<SpecialtyAnalyticsResponse> {
    const range = this.resolveRange(fromInput, toInput);
    const { rows } = await this.database.query<SpecialtyRow>(
      `SELECT d.specialization,
              count(DISTINCT c.id)::int AS consultations,
              COALESCE(sum(pay.amount_cents), 0)::bigint AS revenue_cents
         FROM consultations c
         JOIN doctors d ON d.user_id = c.doctor_id
         LEFT JOIN LATERAL (
           SELECT sum(p.amount_cents) AS amount_cents
             FROM payments p
            WHERE p.consultation_id = c.id
              AND p.captured_at >= $1
              AND p.captured_at < $2
              AND p.status IN ('captured', 'partially_refunded', 'refunded')
         ) pay ON true
        WHERE c.scheduled_start >= $1
          AND c.scheduled_start < $2
        GROUP BY d.specialization
        ORDER BY consultations DESC, d.specialization ASC`,
      [range.from, range.to],
    );

    const currencyResult = await this.database.query<{ currency: string }>(
      `SELECT COALESCE(
         (SELECT p.currency FROM payments p
           WHERE p.captured_at >= $1 AND p.captured_at < $2
           ORDER BY p.captured_at DESC LIMIT 1),
         (SELECT d.currency FROM doctors d ORDER BY d.user_id LIMIT 1),
         'INR'
       ) AS currency`,
      [range.from, range.to],
    );

    return {
      range: range.response,
      currency: currencyResult.rows[0]?.currency.trim() ?? 'INR',
      data: rows.map((row): SpecialtyMetric => ({
        specialization: row.specialization,
        consultations: row.consultations,
        revenueCents: Number(row.revenue_cents),
      })),
    };
  }

  private resolveRange(fromInput?: Date, toInput?: Date): ResolvedRange {
    const to = toInput ?? new Date();
    const from = fromInput ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid analytics date range',
      });
    }

    if (from >= to) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'The analytics range must end after it starts',
      });
    }

    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: `The analytics range cannot exceed ${MAX_RANGE_DAYS} days`,
      });
    }

    return {
      from,
      to,
      response: { from: from.toISOString(), to: to.toISOString() },
    };
  }
}
