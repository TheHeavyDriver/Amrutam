import { describe, expect, it } from 'vitest';
import { deterministicUuid } from './ids.js';

describe('deterministicUuid', () => {
  it('is stable for the same namespace', () => {
    expect(deterministicUuid('user:doctor:1')).toBe(deterministicUuid('user:doctor:1'));
  });

  it('produces distinct RFC 4122 UUIDs', () => {
    const first = deterministicUuid('user:doctor:1');
    const second = deterministicUuid('user:doctor:2');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('has no version or variant collisions across many namespaces', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => deterministicUuid(`seed:${index}`));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id[14] === '7')).toBe(true);
    expect(ids.every((id) => ['8', '9', 'a', 'b'].includes(id[19] ?? ''))).toBe(true);
  });
});
