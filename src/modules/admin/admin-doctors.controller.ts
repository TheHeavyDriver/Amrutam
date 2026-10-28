import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import type { DoctorDetail, DoctorDetailListResponse } from '../doctors/doctors.types.js';
import {
  adminDoctorIdSchema,
  adminDoctorListQuerySchema,
  doctorVerificationSchema,
} from './admin-doctors.schemas.js';
import type { AdminDoctorListQuery, DoctorVerificationInput } from './admin-doctors.schemas.js';
import { AdminDoctorsService } from './admin-doctors.service.js';

@Controller()
export class AdminDoctorsController {
  constructor(private readonly adminDoctorsService: AdminDoctorsService) {}

  @Get('admin/doctors')
  @Roles('admin')
  @Header('Cache-Control', 'no-store')
  list(
    @Query(new ZodValidationPipe(adminDoctorListQuerySchema)) query: AdminDoctorListQuery,
  ): Promise<DoctorDetailListResponse> {
    return this.adminDoctorsService.list(query);
  }

  @Patch('admin/doctors/:doctorId/verification')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async updateVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('doctorId', new ZodValidationPipe(adminDoctorIdSchema)) doctorId: string,
    @Body(new ZodValidationPipe(doctorVerificationSchema)) body: DoctorVerificationInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DoctorDetail> {
    const result = await this.adminDoctorsService.updateVerification(
      user,
      idempotencyKey,
      doctorId,
      body,
      this.metadata(request),
    );

    if (result.replayed) {
      reply.header('Idempotency-Replayed', 'true');
    }

    return result.body;
  }

  private metadata(request: FastifyRequest): RequestMetadata {
    return requestMetadata(request);
  }
}
