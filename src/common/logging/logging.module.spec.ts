import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './request-id.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('accepts a safe client supplied id', () => {
    expect(resolveRequestId('client-request_123:abc.def')).toBe('client-request_123:abc.def');
  });

  it('uses the first value when the header is repeated', () => {
    expect(resolveRequestId(['first-id', 'second-id'])).toBe('first-id');
  });

  it.each([
    ['newlines', 'id\ninjected'],
    ['spaces', 'not a valid id'],
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
  ])('generates a UUID for %s ids', (_label, value) => {
    expect(resolveRequestId(value)).toMatch(UUID_PATTERN);
  });

  it('generates a UUID when the header is missing', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_PATTERN);
  });
});
