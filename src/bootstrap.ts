import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApplication } from './configure-application.js';
import { AppConfigService } from './config/app-config.service.js';
import { loadConfiguration } from './config/configuration.js';
import { createFastifyAdapter } from './create-fastify-adapter.js';

export async function bootstrap(): Promise<void> {
  // Loaded before Nest so the Fastify adapter receives HTTP limits up front.
  // The ConfigModule validates the same environment again for DI consumers.
  const startupConfig = loadConfiguration();

  const adapter = createFastifyAdapter(startupConfig);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);

  await configureApplication(app, config);

  app.enableShutdownHooks();

  await app.listen(config.http.port, config.http.host);

  app
    .get(Logger)
    .log(
      `HTTP server listening on http://${config.http.host}:${config.http.port} (${config.nodeEnv})`,
    );
}
