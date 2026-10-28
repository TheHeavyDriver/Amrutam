import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrescriptionCursor {
  v: 1;
  createdAt: string;
  id: string;
}

function invalidCursor(): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, {
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Invalid cursor',
  });
}

export function encodePrescriptionCursor(cursor: PrescriptionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePrescriptionCursor(value: string): PrescriptionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      throw invalidCursor();
    }

    const record = parsed as Record<string, unknown>;

    if (
      record.v !== 1 ||
      typeof record.createdAt !== 'string' ||
      Number.isNaN(Date.parse(record.createdAt)) ||
      typeof record.id !== 'string' ||
      !UUID_PATTERN.test(record.id)
    ) {
      throw invalidCursor();
    }

    return { v: 1, createdAt: record.createdAt, id: record.id };
  } catch (error) {
    if (error instanceof ApiException) {
      throw error;
    }

    throw invalidCursor();
  }
}
