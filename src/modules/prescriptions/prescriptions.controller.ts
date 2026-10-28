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
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser, RequestMetadata } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Public } from '../../common/auth/public.decorator.js';
import { requestMetadata } from '../../common/auth/request-metadata.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  createPrescriptionSchema,
  listPrescriptionsQuerySchema,
  prescriptionDocumentQuerySchema,
  prescriptionIdSchema,
  updatePrescriptionSchema,
  voidPrescriptionSchema,
} from './prescriptions.schemas.js';
import type {
  CreatePrescriptionInput,
  ListPrescriptionsQuery,
  PrescriptionDocumentQuery,
  UpdatePrescriptionInput,
  VoidPrescriptionInput,
} from './prescriptions.schemas.js';
import { PrescriptionsService } from './prescriptions.service.js';
import type {
  Prescription,
  PrescriptionDocument,
  PrescriptionListResponse,
} from './prescriptions.types.js';

@Controller()
export class PrescriptionsController {
  constructor(private readonly prescriptionsService: PrescriptionsService) {}

  @Post('bookings/:consultationId/prescriptions')
  @Roles('doctor')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('consultationId', new ZodValidationPipe(prescriptionIdSchema))
    consultationId: string,
    @Body(new ZodValidationPipe(createPrescriptionSchema)) body: CreatePrescriptionInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Prescription> {
    const result = await this.prescriptionsService.create(
      user,
      idempotencyKey,
      consultationId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Get('bookings/:consultationId/prescriptions')
  @Roles('patient', 'doctor', 'admin')
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('consultationId', new ZodValidationPipe(prescriptionIdSchema))
    consultationId: string,
    @Query(new ZodValidationPipe(listPrescriptionsQuerySchema)) query: ListPrescriptionsQuery,
  ): Promise<PrescriptionListResponse> {
    return this.prescriptionsService.list(user, consultationId, query);
  }

  @Get('prescriptions/:prescriptionId')
  @Roles('patient', 'doctor', 'admin')
  @Header('Cache-Control', 'no-store')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('prescriptionId', new ZodValidationPipe(prescriptionIdSchema))
    prescriptionId: string,
  ): Promise<Prescription> {
    return this.prescriptionsService.get(user, prescriptionId);
  }

  @Patch('prescriptions/:prescriptionId')
  @Roles('doctor')
  @Header('Cache-Control', 'no-store')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('prescriptionId', new ZodValidationPipe(prescriptionIdSchema))
    prescriptionId: string,
    @Body(new ZodValidationPipe(updatePrescriptionSchema)) body: UpdatePrescriptionInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Prescription> {
    const result = await this.prescriptionsService.update(
      user,
      idempotencyKey,
      prescriptionId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post('prescriptions/:prescriptionId/sign')
  @Roles('doctor')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async sign(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('prescriptionId', new ZodValidationPipe(prescriptionIdSchema))
    prescriptionId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Prescription> {
    const result = await this.prescriptionsService.sign(
      user,
      idempotencyKey,
      prescriptionId,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Post('prescriptions/:prescriptionId/void')
  @Roles('doctor', 'admin')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async void(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('prescriptionId', new ZodValidationPipe(prescriptionIdSchema))
    prescriptionId: string,
    @Body(new ZodValidationPipe(voidPrescriptionSchema)) body: VoidPrescriptionInput,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Prescription> {
    const result = await this.prescriptionsService.void(
      user,
      idempotencyKey,
      prescriptionId,
      body,
      this.metadata(request),
    );
    this.setReplayHeader(reply, result.replayed);
    return result.body;
  }

  @Get('prescriptions/:prescriptionId/document')
  @Roles('patient', 'doctor', 'admin')
  @Header('Cache-Control', 'no-store')
  getDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('prescriptionId', new ZodValidationPipe(prescriptionIdSchema))
    prescriptionId: string,
  ): Promise<PrescriptionDocument> {
    return this.prescriptionsService.getDocument(user, prescriptionId);
  }

  @Public()
  @Get('prescriptions/:prescriptionId/document/content')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadDocument(
    @Param('prescriptionId', new ZodValidationPipe(prescriptionIdSchema))
    prescriptionId: string,
    @Query(new ZodValidationPipe(prescriptionDocumentQuerySchema))
    query: PrescriptionDocumentQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const document = await this.prescriptionsService.downloadDocument(
      prescriptionId,
      query.expires,
      query.signature,
      this.metadata(request),
    );

    void reply
      .header('Content-Type', document.contentType)
      .header('Content-Disposition', `attachment; filename="prescription-${prescriptionId}.html"`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
      .header('Content-Length', String(document.content.length))
      .send(document.content);
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
