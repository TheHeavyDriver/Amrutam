import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConsultationCursor {
  v: 1;
  scheduledStart: string;
  id: string;
}

function invalidCursor(): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, {
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Invalid cursor',
  });
}

export function encodeConsultationCursor(cursor: ConsultationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeConsultationCursor(value: string): ConsultationCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      throw invalidCursor();
    }

    const record = parsed as Record<string, unknown>;

    if (
      record.v !== 1 ||
      typeof record.scheduledStart !== 'string' ||
      Number.isNaN(Date.parse(record.scheduledStart)) ||
      typeof record.id !== 'string' ||
      !UUID_PATTERN.test(record.id)
    ) {
      throw invalidCursor();
    }

    return { v: 1, scheduledStart: record.scheduledStart, id: record.id };
  } catch (error) {
    if (error instanceof ApiException) {
      throw error;
    }

    throw invalidCursor();
  }
}
