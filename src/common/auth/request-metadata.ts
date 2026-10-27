import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser, RequestMetadata } from './auth-user.js';

export interface AuthenticatedRequest extends FastifyRequest {
  user?: AuthenticatedUser;
}

export function requestMetadata(request: FastifyRequest): RequestMetadata {
  const userAgent = request.headers['user-agent'];

  return {
    requestId: request.id,
    ...(request.ip ? { sourceIp: request.ip } : {}),
    ...(typeof userAgent === 'string' ? { userAgent: userAgent.slice(0, 512) } : {}),
  };
}
