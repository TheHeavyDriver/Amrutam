import { Module } from '@nestjs/common';
import { CacheModule } from '../../cache/cache.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DoctorAvailabilityController } from './doctor-availability.controller.js';
import { DoctorsController } from './doctors.controller.js';
import { DoctorsService } from './doctors.service.js';

@Module({
  imports: [CacheModule, AuditModule],
  controllers: [DoctorsController, DoctorAvailabilityController],
  providers: [DoctorsService],
  exports: [DoctorsService],
})
export class DoctorsModule {}
