import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import { requestMetadata } from '../../common/auth/request-metadata.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  createPaymentSchema,
  paymentIdSchema,
  paymentProviderSchema,
  paymentWebhookSchema,
  refundPaymentSchema,
} from './payments.schemas.js';
import type {
  CreatePaymentInput,
  PaymentProviderPath,
  PaymentWebhookInput,
  RefundPaymentInput,
} from './payments.schemas.js';
import { PaymentsService } from './payments.service.js';
import type {
  MessageResponse,
  Payment,
  PaymentIntentResponse,
  PaymentListResponse,
} from './payments.types.js';

@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('bookings/:consultationId/payments')
  @Roles('patient')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async createIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(paymentIdSchema))
    consultationId: string,
    @Body(new ZodValidationPipe(createPaymentSchema)) body: CreatePaymentInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PaymentIntentResponse> {
    const result = await this.paymentsService.createIntent(
      user,
      idempotencyKey,
      consultationId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Get('bookings/:consultationId/payments')
  @Roles('patient', 'admin')
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', new ZodValidationPipe(paymentIdSchema))
    consultationId: string,
  ): Promise<PaymentListResponse> {
    return this.paymentsService.list(user, consultationId);
  }

  @Get('payments/:paymentId')
  @Roles('patient', 'admin')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('paymentId', new ZodValidationPipe(paymentIdSchema)) paymentId: string,
  ): Promise<Payment> {
    return this.paymentsService.get(user, paymentId);
  }

  @Post('payments/:paymentId/confirm')
  @Roles('patient', 'admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('paymentId', new ZodValidationPipe(paymentIdSchema)) paymentId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Payment> {
    const result = await this.paymentsService.confirm(
      user,
      idempotencyKey,
      paymentId,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post('payments/:paymentId/refund')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refund(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('paymentId', new ZodValidationPipe(paymentIdSchema)) paymentId: string,
    @Body(new ZodValidationPipe(refundPaymentSchema)) body: RefundPaymentInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Payment> {
    const result = await this.paymentsService.refund(
      user,
      idempotencyKey,
      paymentId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Public()
  @Post('webhooks/payments/:provider')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  webhook(
    @Param('provider', new ZodValidationPipe(paymentProviderSchema))
    provider: PaymentProviderPath,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Body(new ZodValidationPipe(paymentWebhookSchema)) body: PaymentWebhookInput,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<MessageResponse> {
    return this.paymentsService.handleWebhook(
      provider,
      request.rawBody,
      signature,
      body,
      this.metadata(request),
    );
  }

  private metadata(request: FastifyRequest): RequestMetadata {
    return requestMetadata(request);
  }

  private setReplayHeader(reply: FastifyReply, replayed: boolean): void {
    if (replayed) {
      reply.header('Idempotency-Replayed', 'true');
    }
  }
}
