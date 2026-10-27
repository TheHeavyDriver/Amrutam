import { Controller, Get, Header, Query } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';
import type { AuditChainVerificationResult, AuditLogPage } from './audit.service.js';
import { auditLogQuerySchema, auditVerifyQuerySchema } from './audit.schemas.js';
import type { AuditLogQuery, AuditVerifyQuery } from './audit.schemas.js';

@Roles('admin')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query(new ZodValidationPipe(auditLogQuerySchema)) query: AuditLogQuery,
  ): Promise<AuditLogPage> {
    return this.auditService.list(query);
  }

  @Get('verify')
  @Header('Cache-Control', 'no-store')
  verify(
    @Query(new ZodValidationPipe(auditVerifyQuerySchema)) query: AuditVerifyQuery,
  ): Promise<AuditChainVerificationResult> {
    return this.auditService.verifyChain({
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
  }
}
