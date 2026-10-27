import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const OPAQUE_TOKEN_BYTES = 32;

export function generateOpaqueToken(bytes = OPAQUE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored as keyed hashes. A database leak alone is not enough to
 * replay a refresh, verification, or recovery token.
 */
export function hashOpaqueToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
