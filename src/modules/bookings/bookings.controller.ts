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
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { requestMetadata } from '../../common/auth/request-metadata.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  cancelBookingSchema,
  completeConsultationSchema,
  consultationIdSchema,
  createBookingSchema,
  listBookingsQuerySchema,
  noShowSchema,
  rescheduleBookingSchema,
} from './bookings.schemas.js';
import type {
  CancelBookingInput,
  CompleteConsultationInput,
  CreateBookingInput,
  ListBookingsQuery,
  NoShowInput,
  RescheduleBookingInput,
} from './bookings.schemas.js';
import { BookingsService } from './bookings.service.js';
import type {
  Consultation,
  ConsultationListResponse,
  JoinTokenResponse,
} from './bookings.types.js';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @Roles('patient')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createBookingSchema)) body: CreateBookingInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Consultation> {
    const result = await this.bookingsService.create(
      user,
      idempotencyKey,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Get()
  @Roles('patient', 'doctor', 'admin')
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listBookingsQuerySchema)) query: ListBookingsQuery,
  ): Promise<ConsultationListResponse> {
    return this.bookingsService.list(user, query);
  }

  @Get(':consultationId')
  @Roles('patient', 'doctor', 'admin')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
  ): Promise<Consultation> {
    return this.bookingsService.get(user, consultationId);
  }

  @Post(':consultationId/cancel')
  @Roles('patient', 'admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
    @Body(new ZodValidationPipe(cancelBookingSchema)) body: CancelBookingInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Consultation> {
    const result = await this.bookingsService.cancel(
      user,
      idempotencyKey,
      consultationId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post(':consultationId/reschedule')
  @Roles('patient', 'admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
    @Body(new ZodValidationPipe(rescheduleBookingSchema)) body: RescheduleBookingInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Consultation> {
    const result = await this.bookingsService.reschedule(
      user,
      idempotencyKey,
      consultationId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post(':consultationId/join-token')
  @Roles('patient', 'doctor')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  createJoinToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
    @Req() request: FastifyRequest,
  ): Promise<JoinTokenResponse> {
    return this.bookingsService.createJoinToken(user, consultationId, this.metadata(request));
  }

  @Post(':consultationId/start')
  @Roles('doctor')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Consultation> {
    const result = await this.bookingsService.start(
      user,
      idempotencyKey,
      consultationId,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post(':consultationId/complete')
  @Roles('doctor')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
    @Body(new ZodValidationPipe(completeConsultationSchema)) body: CompleteConsultationInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Consultation> {
    const result = await this.bookingsService.complete(
      user,
      idempotencyKey,
      consultationId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post(':consultationId/no-show')
  @Roles('doctor', 'admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async noShow(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(consultationIdSchema))
    consultationId: string,
    @Body(new ZodValidationPipe(noShowSchema)) body: NoShowInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Consultation> {
    const result = await this.bookingsService.noShow(
      user,
      idempotencyKey,
      consultationId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
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
