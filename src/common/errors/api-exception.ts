import { HttpException } from '@nestjs/common';
import type { HttpStatus } from '@nestjs/common';

export interface ApiErrorDetail {
  field: string;
  message: string;
  code?: string;
}

export interface ApiErrorOptions {
  code: string;
  message: string;
  details?: ApiErrorDetail[];
  retryAfterSeconds?: number;
}

/**
 * HttpException with a stable machine code and optional field details. The
 * global filter turns this into the shared public error envelope.
 */
export class ApiException extends HttpException {
  readonly retryAfterSeconds?: number;

  constructor(status: HttpStatus, options: ApiErrorOptions) {
    super(
      {
        code: options.code,
        message: options.message,
        ...(options.details === undefined ? {} : { details: options.details }),
      },
      status,
    );

    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
