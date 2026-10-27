import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { loadConfiguration } from './configuration.js';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      load: [loadConfiguration],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigurationModule {}
