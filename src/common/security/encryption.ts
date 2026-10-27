import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error('Encryption key must decode to exactly 32 bytes');
  }

  return key;
}

/**
 * Encrypts a small secret (for example a TOTP seed) using AES-256-GCM. The
 * random IV makes ciphertexts non-deterministic, and the auth tag detects
 * tampering before plaintext is returned.
 */
export function encryptSecret(plaintext: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split('.');

  if (version !== VERSION || !encodedIv || !encodedTag || encodedCiphertext === undefined) {
    throw new Error('Unsupported encrypted secret format');
  }

  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
