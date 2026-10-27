import { createHmac, randomBytes } from 'node:crypto';
import { constantTimeEqual } from './tokens.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_BYTES = 20;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 31] ?? '';
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? '';
  }

  return output;
}

function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
  const output: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);

    if (index === -1) {
      throw new Error('Invalid base32 secret');
    }

    value = ((value << 5) | index) >>> 0;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }

  if (output.length === 0) {
    throw new Error('Empty base32 secret');
  }

  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

export function generateTotpCode(
  secret: string,
  timestampMs = Date.now(),
  periodSeconds = TOTP_PERIOD_SECONDS,
  digits = TOTP_DIGITS,
): string {
  const counter = Math.floor(timestampMs / 1000 / periodSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  const code = (binary % 10 ** digits).toString().padStart(digits, '0');

  return code;
}

export function verifyTotpCode(
  secret: string,
  code: string,
  options: { window?: number; timestampMs?: number } = {},
): boolean {
  if (!/^[0-9]{6}$/.test(code)) {
    return false;
  }

  const window = options.window ?? 1;
  const timestampMs = options.timestampMs ?? Date.now();

  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = generateTotpCode(secret, timestampMs + offset * TOTP_PERIOD_SECONDS * 1000);

    if (constantTimeEqual(candidate, code)) {
      return true;
    }
  }

  return false;
}

export function totpProvisioningUri(secret: string, accountName: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });

  return `otpauth://totp/${label}?${query.toString()}`;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(10);
    const characters = Array.from(raw, (byte) => RECOVERY_ALPHABET[byte & 31] ?? 'A').join('');
    return `${characters.slice(0, 5)}-${characters.slice(5, 10)}`;
  });
}
