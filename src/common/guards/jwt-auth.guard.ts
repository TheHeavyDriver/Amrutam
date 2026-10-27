import { HttpStatus, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/request-metadata.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ApiException } from '../errors/api-exception.js';
import { ErrorCodes } from '../errors/error-codes.js';
import { AuthService } from '../../modules/auth/auth.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Authentication is required',
      });
    }

    try {
      request.user = await this.authService.authenticateAccessToken(token);
      return true;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }

      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Access token is invalid or expired',
      });
    }
  }
}
