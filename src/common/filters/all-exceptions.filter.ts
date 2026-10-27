import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';
import type { ApiErrorBody } from '../errors/api-error.js';
import { ErrorCodes } from '../errors/error-codes.js';

const DEFAULT_CODES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCodes.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCodes.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCodes.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCodes.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCodes.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCodes.UNPROCESSABLE_ENTITY,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCodes.TOO_MANY_REQUESTS,
  [HttpStatus.INTERNAL_SERVER_ERROR]: ErrorCodes.INTERNAL_SERVER_ERROR,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCodes.SERVICE_UNAVAILABLE,
};

interface NormalizedError {
  code: string;
  message: string;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<FastifyReply>();
    const request = context.getRequest<FastifyRequest>();
    const requestId = request.id;
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const normalized = this.normalizeError(exception, status);

    if (status >= 500) {
      this.logger.error(
        { err: exception, requestId, statusCode: status, code: normalized.code },
        'Request failed with an unexpected error',
      );
    } else {
      this.logger.warn(
        { requestId, statusCode: status, code: normalized.code },
        normalized.message,
      );
    }

    const body: ApiErrorBody = {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
      },
    };

    response.status(status).send(body);
  }

  private normalizeError(exception: unknown, status: number): NormalizedError {
    const fallbackCode = DEFAULT_CODES[status] ?? ErrorCodes.HTTP_ERROR;

    if (!(exception instanceof HttpException)) {
      return {
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'An unexpected error occurred',
      };
    }

    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { code: fallbackCode, message: payload };
    }

    if (!isRecord(payload)) {
      return { code: fallbackCode, message: exception.message };
    }

    const code = typeof payload.code === 'string' ? payload.code : fallbackCode;
    const message = this.normalizeMessage(payload.message, exception.message);

    return {
      code,
      message,
      ...(payload.details === undefined ? {} : { details: payload.details }),
    };
  }

  private normalizeMessage(message: unknown, fallback: string): string {
    if (typeof message === 'string') {
      return message;
    }

    if (Array.isArray(message)) {
      const parts = message.filter((part): part is string => typeof part === 'string');
      if (parts.length > 0) {
        return parts.join('; ');
      }
    }

    return fallback;
  }
}
