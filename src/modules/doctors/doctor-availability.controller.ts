import {
  Body,
  Controller,
  Delete,
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
import { requestMetadata } from '../../common/auth/request-metadata.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  availabilityQuerySchema,
  availabilitySlotIdSchema,
  createAvailabilitySlotSchema,
} from './doctors.schemas.js';
import type { AvailabilityQuery, CreateAvailabilitySlotInput } from './doctors.schemas.js';
import { DoctorsService } from './doctors.service.js';
import type { AvailabilityListResponse, AvailabilitySlot } from './doctors.types.js';

@Roles('doctor')
@Controller('doctors/me/availability')
export class DoctorAvailabilityController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<AvailabilityListResponse> {
    return this.doctorsService.listOwnAvailability(user, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createAvailabilitySlotSchema)) body: CreateAvailabilitySlotInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AvailabilitySlot> {
    const result = await this.doctorsService.createAvailabilitySlot(
      user,
      idempotencyKey,
      body,
      this.metadata(request),
    );

    if (result.replayed) {
      reply.header('Idempotency-Replayed', 'true');
    }

    return result.body;
  }

  @Delete(':slotId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('slotId', new ZodValidationPipe(availabilitySlotIdSchema)) slotId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const result = await this.doctorsService.deleteAvailabilitySlot(
      user,
      idempotencyKey,
      slotId,
      this.metadata(request),
    );

    if (result.replayed) {
      reply.header('Idempotency-Replayed', 'true');
    }
  }

  private metadata(request: FastifyRequest): RequestMetadata {
    return requestMetadata(request);
  }
}
