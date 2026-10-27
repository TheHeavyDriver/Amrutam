import { HttpStatus, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiException } from '../errors/api-exception.js';
import { ErrorCodes } from '../errors/error-codes.js';

@Injectable()
export class ZodValidationPipe<Output> implements PipeTransform<unknown, Output> {
  constructor(private readonly schema: ZodType<Output>) {}

  transform(value: unknown): Output {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Request validation failed',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data;
  }
}
