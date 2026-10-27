import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './encryption.js';
import { hashPassword, passwordPolicyViolation, verifyPassword } from './password.js';
import { constantTimeEqual, generateOpaqueToken, hashOpaqueToken } from './tokens.js';
import {
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpCode,
} from './totp.js';

const KEY = Buffer.alloc(32, 11).toString('base64');
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('password security', () => {
  it('hashes passwords with Argon2id and verifies them', async () => {
    const hash = await hashPassword('A-long-demo-password!2026');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword('A-long-demo-password!2026', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });

  it('rejects short, common, and repeated passwords', () => {
    expect(passwordPolicyViolation('short')).toMatch(/12/);
    expect(passwordPolicyViolation('password1234')).toMatch(/common/);
    expect(passwordPolicyViolation('aaaaaaaaaaaa')).toMatch(/repeat/);
    expect(passwordPolicyViolation('A-suitable-password!2026')).toBeNull();
  });

  it('returns false rather than throwing for a malformed hash', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
  });
});

describe('encryption', () => {
  it('round-trips a secret and uses a fresh IV each time', () => {
    const first = encryptSecret('JBSWY3DPEHPK3PXP', KEY);
    const second = encryptSecret('JBSWY3DPEHPK3PXP', KEY);

    expect(first).not.toBe(second);
    expect(decryptSecret(first, KEY)).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(second, KEY)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects tampered ciphertext and malformed keys', () => {
    const encrypted = encryptSecret('sensitive', KEY);
    const parts = encrypted.split('.');
    const ciphertext = parts[3];

    if (!ciphertext) {
      throw new Error('Missing ciphertext');
    }

    parts[3] = ciphertext.slice(0, -1) + (ciphertext.endsWith('A') ? 'B' : 'A');

    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
    expect(() => decryptSecret(encrypted, Buffer.alloc(16, 1).toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});

describe('opaque tokens', () => {
  it('generates high-entropy tokens and stores only keyed hashes', () => {
    const token = generateOpaqueToken();

    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashOpaqueToken(token, 'pepper')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(token, 'pepper')).toBe(hashOpaqueToken(token, 'pepper'));
    expect(hashOpaqueToken(token, 'other-pepper')).not.toBe(hashOpaqueToken(token, 'pepper'));
  });

  it('compares strings without leaking length mismatches', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vector for a six-digit code', () => {
    expect(generateTotpCode(RFC_SECRET, 59_000)).toBe('287082');
  });

  it('accepts adjacent time steps within the configured window only', () => {
    const code = generateTotpCode(RFC_SECRET, 1_111_111_111_000);

    expect(verifyTotpCode(RFC_SECRET, code, { timestampMs: 1_111_111_111_000 })).toBe(true);
    expect(
      verifyTotpCode(RFC_SECRET, code, {
        timestampMs: 1_111_111_111_000 + 30_000,
      }),
    ).toBe(true);
    expect(
      verifyTotpCode(RFC_SECRET, code, {
        timestampMs: 1_111_111_111_000 + 120_000,
        window: 1,
      }),
    ).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, 'abcdef', { timestampMs: 1_111_111_111_000 })).toBe(false);
  });

  it('generates base32 secrets and provisioning URIs', () => {
    const secret = generateTotpSecret();

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(generateTotpCode(secret)).toMatch(/^[0-9]{6}$/);

    const uri = totpProvisioningUri(secret, 'doctor@amrutam.local', 'Amrutam');
    expect(uri).toContain('otpauth://totp/Amrutam:doctor%40amrutam.local');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Amrutam');
  });

  it('issues human-readable one-time recovery codes', () => {
    const codes = generateRecoveryCodes(10);

    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
    expect(new Set(codes).size).toBe(10);
  });
});
