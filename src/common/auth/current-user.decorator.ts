import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './auth-user.js';
import type { AuthenticatedRequest } from './request-metadata.js';

/** Injects the user verified by the global auth guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new Error('CurrentUser used on an unauthenticated route');
    }

    return request.user;
  },
);
