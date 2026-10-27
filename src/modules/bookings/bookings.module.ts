import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DoctorsModule } from '../doctors/doctors.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [AuditModule, DoctorsModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
