import { randomUUID } from 'node:crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;

  if (candidate && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}
