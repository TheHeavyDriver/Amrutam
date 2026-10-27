import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/configure-application.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { loadConfiguration } from '../../src/config/configuration.js';
import { createFastifyAdapter } from '../../src/create-fastify-adapter.js';

export async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(loadConfiguration()),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  await configureApplication(app, app.get(AppConfigService));
  await app.init();

  return app;
}
