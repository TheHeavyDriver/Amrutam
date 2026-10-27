import { randomBytes } from 'node:crypto';
import { argon2Verify, argon2id } from 'hash-wasm';

// OWASP's Argon2id baseline: 19 MiB, two passes, one lane.
const ARGON2_MEMORY_KIB = 19_456;
const ARGON2_ITERATIONS = 2;
const ARGON2_PARALLELISM = 1;
const ARGON2_HASH_LENGTH = 32;
const ARGON2_SALT_BYTES = 16;

const COMMON_PASSWORDS = new Set([
  '123456789012',
  'password1234',
  'password12345',
  'qwertyuiop12',
  'qwerty123456',
  'letmein123456',
  'amrutam12345',
  'amrutam123456',
  'administrator1',
  'welcome123456',
]);

export function passwordPolicyViolation(password: string): string | null {
  if (password.length < 12) {
    return 'Password must be at least 12 characters';
  }

  if (password.length > 128) {
    return 'Password must be at most 128 characters';
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'Password is too common';
  }

  if (/^(.)\1+$/.test(password)) {
    return 'Password must not repeat a single character';
  }

  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(ARGON2_SALT_BYTES),
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}
