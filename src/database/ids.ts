import { createHash } from 'node:crypto';

/**
 * Produces a stable RFC 4122 UUID with the version-7 nibble set. Deterministic
 * ids make demo datasets idempotent across repeated seed runs.
 */
export function deterministicUuid(namespace: string): string {
  const hex = createHash('sha256').update(namespace).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `7${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
