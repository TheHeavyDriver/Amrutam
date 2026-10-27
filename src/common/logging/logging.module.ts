import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';
import { AppConfigService } from '../../config/app-config.service.js';
import { ConfigurationModule } from '../../config/configuration.module.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logging.level,
          base: {
            service: config.service.name,
            environment: config.nodeEnv,
            version: config.service.version,
          },
          timestamp: pino.stdTimeFunctions.isoTime,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'res.headers["set-cookie"]',
              'req.body.password',
              'req.body.currentPassword',
              'req.body.newPassword',
              'req.body.token',
              'req.body.refreshToken',
              '*.password',
              '*.token',
              '*.accessToken',
              '*.refreshToken',
            ],
            censor: '[REDACTED]',
          },
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/health') ?? false,
          },
          transport: config.logging.pretty
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  singleLine: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
        },
        renameContext: 'context',
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
