import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { NotificationService } from './notification.service.js';
import { OutboxDispatcherService } from './outbox-dispatcher.service.js';
import { ScheduledJobsService } from './scheduled-jobs.service.js';

@Module({
  imports: [AuditModule, PaymentsModule],
  providers: [NotificationService, OutboxDispatcherService, ScheduledJobsService],
  exports: [OutboxDispatcherService, ScheduledJobsService],
})
export class JobsModule {}
