import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [AuditModule],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  exports: [AuthService],
})
export class AuthModule {}
