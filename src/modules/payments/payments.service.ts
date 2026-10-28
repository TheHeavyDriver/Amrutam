import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import {
  IdempotencyService,
  type IdempotentExecutionResult,
} from '../../common/idempotency/idempotency.service.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  CreatePaymentInput,
  PaymentProviderPath,
  PaymentWebhookInput,
  RefundPaymentInput,
} from './payments.schemas.js';
import type {
  MessageResponse,
  Payment,
  PaymentIntentResponse,
  PaymentListResponse,
  PaymentProvider,
  PaymentStatus,
} from './payments.types.js';

interface PaymentRow {
  id: string;
  consultation_id: string;
  patient_id: string;
  amount_cents: number;
  amount_refunded_cents: number;
  currency: string;
  status: PaymentStatus;
  provider: PaymentProvider;
  provider_reference: string | null;
  failure_code: string | null;
  authorized_at: Date | null;
  captured_at: Date | null;
  failed_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ConsultationPaymentRow {
  patient_id: string;
  doctor_id: string;
  status: string;
  fee_cents: number;
  currency: string;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async createIntent(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    consultationId: string,
    input: CreatePaymentInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<PaymentIntentResponse>> {
    this.requireRole(user, ['patient']);

    return this.idempotency.execute<PaymentIntentResponse>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/bookings/${consultationId}/payments`,
        body: input,
        request,
      },
      async (client) => {
        const consultation = await this.lockConsultation(client, consultationId);

        if (consultation.patient_id !== user.id) {
          throw new ApiException(HttpStatus.FORBIDDEN, {
            code: ErrorCodes.FORBIDDEN,
            message: 'You can only pay for your own consultations',
          });
        }

        if (consultation.status === 'cancelled' || consultation.status === 'no_show') {
          throw this.invalidTransition(
            'Payments cannot be created for a cancelled or no-show consultation',
          );
        }

        if (consultation.fee_cents <= 0) {
          throw this.invalidTransition('This consultation does not require payment');
        }

        const existing = await client.query<{ id: string }>(
          `SELECT id
             FROM payments
            WHERE consultation_id = $1
              AND status IN ('pending', 'authorized', 'captured', 'partially_refunded')
            LIMIT 1`,
          [consultationId],
        );

        if (existing.rows[0]) {
          throw new ApiException(HttpStatus.CONFLICT, {
            code: ErrorCodes.PAYMENT_ALREADY_EXISTS,
            message: 'An active payment already exists for this consultation',
          });
        }

        const providerReference = `${input.provider}_${randomUUID().replaceAll('-', '')}`;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO payments (
             consultation_id, patient_id, amount_cents, currency, status,
             provider, provider_reference
           ) VALUES ($1, $2, $3, $4, 'pending', $5, $6)
           RETURNING id`,
          [
            consultationId,
            user.id,
            consultation.fee_cents,
            consultation.currency.trim(),
            input.provider,
            providerReference,
          ],
        );
        const paymentId = inserted.rows[0]?.id;

        if (!paymentId) {
          throw new Error('Failed to create payment intent');
        }

        const payment = await this.loadPayment(client, paymentId);

        await this.enqueue(client, paymentId, 'payment.intent_created', {
          paymentId,
          consultationId,
          patientId: user.id,
          amountCents: payment.amount,
          currency: payment.currency,
          provider: payment.provider,
          providerReference,
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'payment.intent_created',
            resourceType: 'payment',
            resourceId: paymentId,
            request,
            after: { status: 'pending', amountCents: payment.amount, currency: payment.currency },
            metadata: {
              consultationId,
              provider: payment.provider,
              providerReference,
            },
          },
          client,
        );

        return {
          status: HttpStatus.CREATED,
          body: { payment, clientSecret: null },
        };
      },
    );
  }

  async list(user: AuthenticatedUser, consultationId: string): Promise<PaymentListResponse> {
    this.requireRole(user, ['patient', 'admin']);
    const consultation = await this.loadConsultation(consultationId);

    if (user.role === 'patient' && consultation.patient_id !== user.id) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'You do not have permission to access these payments',
      });
    }

    const { rows } = await this.database.query<PaymentRow>(
      `SELECT ${this.paymentColumns()}
         FROM payments
        WHERE consultation_id = $1
        ORDER BY created_at DESC, id DESC`,
      [consultationId],
    );

    return { data: rows.map((row) => this.toPayment(row)) };
  }

  async get(user: AuthenticatedUser, paymentId: string): Promise<Payment> {
    this.requireRole(user, ['patient', 'admin']);
    const payment = await this.loadPayment(null, paymentId);
    this.assertCanViewPayment(user, payment);

    return payment;
  }

  async confirm(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    paymentId: string,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Payment>> {
    this.requireRole(user, ['patient', 'admin']);

    return this.idempotency.execute<Payment>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/payments/${paymentId}/confirm`,
        body: {},
        request,
      },
      async (client) => {
        const current = await this.lockPayment(client, paymentId);
        this.assertCanViewPayment(user, current);

        if (current.status === 'captured') {
          return { status: HttpStatus.OK, body: this.toPayment(current) };
        }

        if (
          current.status === 'refunded' ||
          current.status === 'partially_refunded' ||
          current.status === 'failed'
        ) {
          throw this.invalidTransition(`A ${current.status} payment cannot be captured`);
        }

        const consultationStatus = await this.getConsultationStatus(
          client,
          current.consultation_id,
        );

        if (consultationStatus === 'cancelled' || consultationStatus === 'no_show') {
          throw this.invalidTransition('The consultation is no longer active');
        }

        await client.query(
          `UPDATE payments
              SET status = 'captured',
                  authorized_at = COALESCE(authorized_at, now()),
                  captured_at = now(),
                  failure_code = NULL
            WHERE id = $1`,
          [paymentId],
        );

        const body = await this.loadPayment(client, paymentId);

        await this.enqueue(client, paymentId, 'payment.captured', {
          paymentId,
          consultationId: current.consultation_id,
          patientId: current.patient_id,
          amountCents: body.amount,
          currency: body.currency,
          provider: body.provider,
          source: 'api',
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'payment.captured',
            resourceType: 'payment',
            resourceId: paymentId,
            request,
            before: { status: current.status, amountRefunded: current.amount_refunded_cents },
            after: { status: 'captured', amountRefunded: body.amountRefunded },
            metadata: {
              consultationId: current.consultation_id,
              amountCents: body.amount,
              currency: body.currency,
              provider: body.provider,
              source: 'api',
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );
  }

  async refund(
    user: AuthenticatedUser,
    idempotencyKey: string | undefined,
    paymentId: string,
    input: RefundPaymentInput,
    request: RequestMetadata,
  ): Promise<IdempotentExecutionResult<Payment>> {
    this.requireRole(user, ['admin']);

    return this.idempotency.execute<Payment>(
      {
        actor: user,
        key: idempotencyKey,
        method: 'POST',
        path: `/payments/${paymentId}/refund`,
        body: input,
        request,
      },
      async (client) => {
        const current = await this.lockPayment(client, paymentId);

        if (current.status !== 'captured' && current.status !== 'partially_refunded') {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.PAYMENT_NOT_REFUNDABLE,
            message: 'Only captured payments can be refunded',
          });
        }

        const remaining = current.amount_cents - current.amount_refunded_cents;
        const refundAmount = input.amount ?? remaining;

        if (refundAmount > remaining) {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.PAYMENT_AMOUNT_EXCEEDS_BALANCE,
            message: 'The refund exceeds the remaining captured amount',
          });
        }

        if (refundAmount <= 0) {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.PAYMENT_NOT_REFUNDABLE,
            message: 'There is no remaining balance to refund',
          });
        }

        const totalRefunded = current.amount_refunded_cents + refundAmount;
        const status: PaymentStatus =
          totalRefunded === current.amount_cents ? 'refunded' : 'partially_refunded';

        await client.query(
          `UPDATE payments
              SET status = $2::payment_status,
                  amount_refunded_cents = $3,
                  refunded_at = now()
            WHERE id = $1`,
          [paymentId, status, totalRefunded],
        );
        await client.query(
          `INSERT INTO payment_refunds (
             payment_id, amount_cents, reason, refunded_by_user_id
           ) VALUES ($1, $2, $3, $4)`,
          [paymentId, refundAmount, input.reason, user.id],
        );

        const body = await this.loadPayment(client, paymentId);

        await this.enqueue(client, paymentId, 'payment.refunded', {
          paymentId,
          consultationId: current.consultation_id,
          patientId: current.patient_id,
          amountCents: refundAmount,
          totalRefundedCents: totalRefunded,
          currency: body.currency,
          status,
          source: 'api',
        });

        await this.audit.record(
          {
            actorId: user.id,
            actorRole: user.role,
            action: 'payment.refunded',
            resourceType: 'payment',
            resourceId: paymentId,
            request,
            before: { status: current.status, amountRefunded: current.amount_refunded_cents },
            after: { status, amountRefunded: totalRefunded },
            metadata: {
              consultationId: current.consultation_id,
              refundAmountCents: refundAmount,
              totalRefundedCents: totalRefunded,
              currency: body.currency,
              source: 'api',
            },
          },
          client,
        );

        return { status: HttpStatus.OK, body };
      },
    );
  }

  /**
   * Compensating refund used by the outbox worker after a cancellation. The
   * provider adapter is represented by the local ledger in this deployment;
   * the method is idempotent and safe to retry.
   */
  async refundForSystem(paymentId: string, sourceEventId: string): Promise<boolean> {
    return this.database.withTransaction(async (client) => {
      const current = await this.lockPayment(client, paymentId);

      if (current.status !== 'captured' && current.status !== 'partially_refunded') {
        return false;
      }

      const refundAmount = current.amount_cents - current.amount_refunded_cents;

      if (refundAmount <= 0) {
        return false;
      }

      const totalRefunded = current.amount_cents;
      await client.query(
        `UPDATE payments
            SET status = 'refunded',
                amount_refunded_cents = $2,
                refunded_at = now()
          WHERE id = $1`,
        [paymentId, totalRefunded],
      );
      await client.query(
        `INSERT INTO payment_refunds (
           payment_id, amount_cents, reason, provider_reference
         ) VALUES ($1, $2, 'Consultation cancellation compensation', $3)`,
        [paymentId, refundAmount, `system:${sourceEventId}`],
      );

      const body = await this.loadPayment(client, paymentId);

      await this.enqueue(client, paymentId, 'payment.refunded', {
        paymentId,
        consultationId: body.consultationId,
        patientId: body.patientId,
        amountCents: refundAmount,
        totalRefundedCents: totalRefunded,
        currency: body.currency,
        status: body.status,
        source: 'system',
      });

      await this.audit.record(
        {
          actorId: null,
          actorRole: null,
          action: 'payment.refunded',
          resourceType: 'payment',
          resourceId: paymentId,
          before: {
            status: current.status,
            amountRefunded: current.amount_refunded_cents,
          },
          after: { status: 'refunded', amountRefunded: totalRefunded },
          metadata: {
            consultationId: body.consultationId,
            refundAmountCents: refundAmount,
            totalRefundedCents: totalRefunded,
            currency: body.currency,
            source: 'cancellation_compensation',
            outboxEventId: sourceEventId,
          },
        },
        client,
      );

      return true;
    });
  }

  async handleWebhook(
    provider: PaymentProviderPath,
    rawBody: Buffer | undefined,
    signature: string | undefined,
    input: PaymentWebhookInput,
    request: RequestMetadata,
  ): Promise<MessageResponse> {
    if (!rawBody || rawBody.length === 0) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'A raw webhook body is required',
      });
    }

    this.verifyWebhookSignature(rawBody, signature);
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');

    return this.database.withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO payment_webhook_events (
           provider, event_id, event_type, payment_id, payload_sha256
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [provider, input.eventId, input.eventType, input.paymentId, payloadSha256],
      );

      if (!inserted.rows[0]) {
        return { message: 'Event already processed' };
      }

      const current = await this.lockPayment(client, input.paymentId);

      if (current.provider !== provider) {
        throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
          code: ErrorCodes.UNPROCESSABLE_ENTITY,
          message: 'The payment does not belong to this provider',
        });
      }

      if (current.provider_reference !== input.providerReference) {
        throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
          code: ErrorCodes.UNPROCESSABLE_ENTITY,
          message: 'The provider reference does not match the payment intent',
        });
      }

      if (input.currency && input.currency !== current.currency.trim()) {
        throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
          code: ErrorCodes.UNPROCESSABLE_ENTITY,
          message: 'The webhook currency does not match the payment',
        });
      }

      if (input.eventType === 'payment.authorized' || input.eventType === 'payment.captured') {
        const consultationStatus = await this.getConsultationStatus(
          client,
          current.consultation_id,
        );

        if (consultationStatus === 'cancelled' || consultationStatus === 'no_show') {
          throw this.invalidTransition('The consultation is no longer active');
        }
      }

      let stateChanged = false;
      let auditAction = 'payment.webhook_noop';
      let outboxType: string | null = null;
      let refundDelta = 0;

      switch (input.eventType) {
        case 'payment.authorized': {
          this.assertWebhookAmount(input.amount, current.amount_cents);

          if (current.status === 'pending') {
            await client.query(
              `UPDATE payments
                  SET status = 'authorized',
                      authorized_at = now(),
                      failure_code = NULL
                WHERE id = $1`,
              [input.paymentId],
            );
            stateChanged = true;
            auditAction = 'payment.authorized';
            outboxType = 'payment.authorized';
          } else if (current.status === 'failed') {
            throw this.invalidTransition('A failed payment cannot be authorized');
          }
          break;
        }

        case 'payment.captured': {
          this.assertWebhookAmount(input.amount, current.amount_cents);

          if (current.status === 'pending' || current.status === 'authorized') {
            await client.query(
              `UPDATE payments
                  SET status = 'captured',
                      authorized_at = COALESCE(authorized_at, now()),
                      captured_at = now(),
                      failure_code = NULL
                WHERE id = $1`,
              [input.paymentId],
            );
            stateChanged = true;
            auditAction = 'payment.captured';
            outboxType = 'payment.captured';
          } else if (current.status === 'failed') {
            throw this.invalidTransition('A failed payment cannot be captured');
          }
          break;
        }

        case 'payment.failed': {
          if (current.status === 'pending' || current.status === 'authorized') {
            await client.query(
              `UPDATE payments
                  SET status = 'failed',
                      failed_at = now(),
                      failure_code = 'provider_reported_failure'
                WHERE id = $1`,
              [input.paymentId],
            );
            stateChanged = true;
            auditAction = 'payment.failed';
            outboxType = 'payment.failed';
          } else if (
            current.status === 'captured' ||
            current.status === 'refunded' ||
            current.status === 'partially_refunded'
          ) {
            throw this.invalidTransition('A captured payment cannot fail');
          }
          break;
        }

        case 'payment.refunded': {
          if (
            current.status !== 'captured' &&
            current.status !== 'partially_refunded' &&
            current.status !== 'refunded'
          ) {
            throw this.invalidTransition('Only captured payments can be refunded');
          }

          const targetRefunded = input.amount ?? current.amount_cents;

          if (targetRefunded > current.amount_cents) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
              code: ErrorCodes.PAYMENT_AMOUNT_EXCEEDS_BALANCE,
              message: 'The provider refund exceeds the payment amount',
            });
          }

          if (targetRefunded > current.amount_refunded_cents) {
            refundDelta = targetRefunded - current.amount_refunded_cents;
            const nextStatus: PaymentStatus =
              targetRefunded === current.amount_cents ? 'refunded' : 'partially_refunded';

            await client.query(
              `UPDATE payments
                  SET status = $2::payment_status,
                      amount_refunded_cents = $3,
                      refunded_at = now()
                WHERE id = $1`,
              [input.paymentId, nextStatus, targetRefunded],
            );
            await client.query(
              `INSERT INTO payment_refunds (
                 payment_id, amount_cents, reason, provider_reference
               ) VALUES ($1, $2, 'Provider-reported refund', $3)`,
              [input.paymentId, refundDelta, `${provider}:${input.eventId}`],
            );
            stateChanged = true;
            auditAction = 'payment.refunded';
            outboxType = 'payment.refunded';
          }
          break;
        }
      }

      const body = await this.loadPayment(client, input.paymentId);

      if (stateChanged && outboxType) {
        await this.enqueue(client, input.paymentId, outboxType, {
          paymentId: input.paymentId,
          consultationId: body.consultationId,
          patientId: body.patientId,
          amountCents: body.amount,
          amountRefundedCents: body.amountRefunded,
          currency: body.currency,
          status: body.status,
          provider,
          providerEventId: input.eventId,
          source: 'webhook',
        });
      }

      await this.audit.record(
        {
          actorId: null,
          actorRole: null,
          action: auditAction,
          resourceType: 'payment',
          resourceId: input.paymentId,
          request,
          before: {
            status: current.status,
            amountRefunded: current.amount_refunded_cents,
          },
          after: {
            status: body.status,
            amountRefunded: body.amountRefunded,
          },
          metadata: {
            source: 'webhook',
            provider,
            providerEventId: input.eventId,
            providerEventType: input.eventType,
            stateChanged,
            ...(refundDelta > 0 ? { refundDeltaCents: refundDelta } : {}),
          },
        },
        client,
      );

      return {
        message: stateChanged ? 'Event processed' : 'Event reconciled without a state change',
      };
    });
  }

  private paymentColumns(): string {
    return `id, consultation_id, patient_id, amount_cents, amount_refunded_cents,
            currency, status, provider, provider_reference, failure_code,
            authorized_at, captured_at, failed_at, refunded_at, created_at, updated_at`;
  }

  private async loadPayment(client: PoolClient | null, paymentId: string): Promise<Payment> {
    const sql = `SELECT ${this.paymentColumns()} FROM payments WHERE id = $1`;
    const result = client
      ? await client.query<PaymentRow>(sql, [paymentId])
      : await this.database.query<PaymentRow>(sql, [paymentId]);
    const row = result.rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Payment not found',
      });
    }

    return this.toPayment(row);
  }

  private async lockPayment(client: PoolClient, paymentId: string): Promise<PaymentRow> {
    const { rows } = await client.query<PaymentRow>(
      `SELECT ${this.paymentColumns()}
         FROM payments
        WHERE id = $1
        FOR UPDATE`,
      [paymentId],
    );
    const row = rows[0];

    if (!row) {
      throw new ApiException(HttpStatus.NOT_FOUND, {
        code: ErrorCodes.NOT_FOUND,
        message: 'Payment not found',
      });
    }

    return row;
  }

  private async lockConsultation(
    client: PoolClient,
    consultationId: string,
  ): Promise<ConsultationPaymentRow> {
    const { rows } = await client.query<ConsultationPaymentRow>(
      `SELECT patient_id, doctor_id, status::text AS status, fee_cents, currency
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

  private async loadConsultation(consultationId: string): Promise<ConsultationPaymentRow> {
    const { rows } = await this.database.query<ConsultationPaymentRow>(
      `SELECT patient_id, doctor_id, status::text AS status, fee_cents, currency
         FROM consultations
        WHERE id = $1`,
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

  private async getConsultationStatus(client: PoolClient, consultationId: string): Promise<string> {
    const { rows } = await client.query<{ status: string }>(
      'SELECT status::text AS status FROM consultations WHERE id = $1',
      [consultationId],
    );
    return rows[0]?.status ?? '';
  }

  private assertCanViewPayment(
    user: AuthenticatedUser,
    payment: Pick<PaymentRow, 'patient_id'> | Pick<Payment, 'patientId'>,
  ): void {
    if (user.role === 'admin') {
      return;
    }

    const patientId = 'patient_id' in payment ? payment.patient_id : payment.patientId;

    if (user.role === 'patient' && patientId === user.id) {
      return;
    }

    throw new ApiException(HttpStatus.FORBIDDEN, {
      code: ErrorCodes.FORBIDDEN,
      message: 'You do not have permission to access this payment',
    });
  }

  private requireRole(user: AuthenticatedUser, roles: AuthenticatedUser['role'][]): void {
    if (!roles.includes(user.role)) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'You do not have permission to perform this action',
      });
    }
  }

  private assertWebhookAmount(amount: number | undefined, expected: number): void {
    if (amount !== undefined && amount !== expected) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        code: ErrorCodes.UNPROCESSABLE_ENTITY,
        message: 'The webhook amount does not match the payment',
      });
    }
  }

  private verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): void {
    if (!signature || !/^[0-9a-f]{64}$/.test(signature)) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
        message: 'A valid webhook signature is required',
      });
    }

    const expected = createHmac('sha256', this.config.payments.webhookSecret)
      .update(rawBody)
      .digest();
    const supplied = Buffer.from(signature, 'hex');

    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.INVALID_WEBHOOK_SIGNATURE,
        message: 'The webhook signature is invalid',
      });
    }
  }

  private toPayment(row: PaymentRow): Payment {
    return {
      id: row.id,
      consultationId: row.consultation_id,
      patientId: row.patient_id,
      amount: row.amount_cents,
      amountRefunded: row.amount_refunded_cents,
      currency: row.currency.trim(),
      status: row.status,
      provider: row.provider,
      providerReference: row.provider_reference,
      failureCode: row.failure_code,
      authorizedAt: iso(row.authorized_at),
      capturedAt: iso(row.captured_at),
      refundedAt: iso(row.refunded_at),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async enqueue(
    client: PoolClient,
    paymentId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('payment', $1, $2, $3::jsonb)`,
      [paymentId, eventType, JSON.stringify(payload)],
    );
  }

  private invalidTransition(message: string): ApiException {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
      code: ErrorCodes.INVALID_STATE_TRANSITION,
      message,
    });
  }
}
