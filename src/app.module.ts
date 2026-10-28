import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CacheModule } from './cache/cache.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { IdempotencyModule } from './common/idempotency/idempotency.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { ConfigurationModule } from './config/configuration.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { DoctorsModule } from './modules/doctors/doctors.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { PrescriptionsModule } from './modules/prescriptions/prescriptions.module.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    ConfigurationModule,
    LoggingModule,
    MetricsModule,
    DatabaseModule,
    CacheModule,
    IdempotencyModule,
    AuditModule,
    AuthModule,
    UsersModule,
    BookingsModule,
    DoctorsModule,
    PrescriptionsModule,
    PaymentsModule,
    AdminModule,
    AnalyticsModule,
    HealthModule,
    JobsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
