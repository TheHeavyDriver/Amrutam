import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { ConfigurationModule } from './config/configuration.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [ConfigurationModule, LoggingModule, HealthModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
