import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';
import { resolveRequestId } from './common/logging/request-id.js';
import type { AppConfig } from './config/configuration.js';

export function createFastifyAdapter(config: AppConfig): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: config.http.bodyLimitBytes,
    trustProxy: config.http.trustProxy,
    genReqId: (request: IncomingMessage) => resolveRequestId(request.headers['x-request-id']),
  });
}
