import { HttpStatus, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '../auth/auth-user.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import type { AuthenticatedRequest } from '../auth/request-metadata.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { ApiException } from '../errors/api-exception.js';
import { ErrorCodes } from '../errors/error-codes.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Authentication is required',
      });
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ApiException(HttpStatus.FORBIDDEN, {
        code: ErrorCodes.FORBIDDEN,
        message: 'You do not have permission to perform this action',
      });
    }

    return true;
  }
}
