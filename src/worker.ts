import './instrumentation.js';
import 'dotenv/config';
import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { MetricsService } from './metrics/metrics.service.js';
import { OutboxDispatcherService } from './modules/jobs/outbox-dispatcher.service.js';
import { ScheduledJobsService } from './modules/jobs/scheduled-jobs.service.js';
import { shutdownTracing } from './instrumentation.js';

async function main(): Promise<void> {
  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);
  const metrics = app.get(MetricsService);
  const dispatcher = app.get(OutboxDispatcherService);
  const scheduler = app.get(ScheduledJobsService);
  const metricsPort = config.jobs.workerMetricsPort;

  const server = createServer((request, response) => {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'amrutam-worker' }));
      return;
    }

    if (request.url === '/metrics') {
      void metrics
        .getMetrics()
        .then((body) => {
          response.writeHead(200, { 'content-type': metrics.contentType });
          response.end(body);
        })
        .catch(() => {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'error' }));
        });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(metricsPort, '0.0.0.0', resolve);
  });

  dispatcher.start();
  scheduler.start();
  logger.log({ metricsPort }, 'Worker started');

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.log({ signal }, 'Worker shutting down');

    await dispatcher.stop();
    await scheduler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
    await shutdownTracing();
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((error: unknown) => {
  console.error('Failed to start worker:', error);
  process.exitCode = 1;
});
