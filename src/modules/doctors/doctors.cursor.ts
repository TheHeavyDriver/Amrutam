import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import type { DoctorSort } from './doctors.types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DoctorCursor {
  v: 1;
  sort: DoctorSort;
  id: string;
  rating?: string;
  ratingCount?: number;
  feeCents?: number;
  nextAvailableAt?: string | null;
}

export interface AvailabilityCursor {
  v: 1;
  startsAt: string;
  id: string;
}

function invalidCursor(): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, {
    code: ErrorCodes.VALIDATION_ERROR,
    message: 'Invalid cursor',
  });
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursor();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function encodeDoctorCursor(cursor: DoctorCursor): string {
  return encode(cursor);
}

export function decodeDoctorCursor(value: string, sort: DoctorSort): DoctorCursor {
  const parsed = decode(value);

  if (!isRecord(parsed) || parsed.v !== 1 || parsed.sort !== sort) {
    throw invalidCursor();
  }

  if (typeof parsed.id !== 'string' || !UUID_PATTERN.test(parsed.id)) {
    throw invalidCursor();
  }

  if (sort === 'rating_desc') {
    if (
      typeof parsed.rating !== 'string' ||
      !/^[0-5](?:\.[0-9]{1,2})?$/.test(parsed.rating) ||
      typeof parsed.ratingCount !== 'number' ||
      !Number.isInteger(parsed.ratingCount) ||
      parsed.ratingCount < 0
    ) {
      throw invalidCursor();
    }
  }

  if ((sort === 'fee_asc' || sort === 'fee_desc') && typeof parsed.feeCents !== 'number') {
    throw invalidCursor();
  }

  if (
    sort === 'next_available' &&
    parsed.nextAvailableAt !== null &&
    (typeof parsed.nextAvailableAt !== 'string' || Number.isNaN(Date.parse(parsed.nextAvailableAt)))
  ) {
    throw invalidCursor();
  }

  return parsed as unknown as DoctorCursor;
}

export function encodeAvailabilityCursor(cursor: AvailabilityCursor): string {
  return encode(cursor);
}

export function decodeAvailabilityCursor(value: string): AvailabilityCursor {
  const parsed = decode(value);

  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    typeof parsed.startsAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.startsAt)) ||
    typeof parsed.id !== 'string' ||
    !UUID_PATTERN.test(parsed.id)
  ) {
    throw invalidCursor();
  }

  return parsed as unknown as AvailabilityCursor;
}
