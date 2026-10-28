import { Module } from '@nestjs/common';
import { CacheModule } from '../../cache/cache.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AdminDoctorsController } from './admin-doctors.controller.js';
import { AdminDoctorsService } from './admin-doctors.service.js';

@Module({
  imports: [AuditModule, CacheModule],
  controllers: [AdminDoctorsController],
  providers: [AdminDoctorsService],
})
export class AdminModule {}
