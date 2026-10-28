import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const SECRETS = {
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-characters',
  JWT_MFA_SECRET: 'test-mfa-secret-that-is-at-least-32-characters',
  AUTH_TOKEN_PEPPER: 'test-pepper-that-is-at-least-32-characters',
  AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYMENT_WEBHOOK_SECRET: 'test-payment-webhook-secret-at-least-32-characters',
};

describe('validateEnv', () => {
  it('requires independent auth secrets instead of shipping defaults', () => {
    expect(() => validateEnv({})).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('applies safe defaults once secrets are supplied', () => {
    const env = validateEnv({ ...SECRETS });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_URL).toBe('postgresql://amrutam:amrutam@localhost:5432/amrutam');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
    expect(env.CACHE_ENABLED).toBe(true);
    expect(env.PAYMENT_WEBHOOK_SECRET).toContain('webhook');
    expect(env.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.AUTH_REQUIRE_EMAIL_VERIFICATION).toBe(true);
    expect(env.RATE_LIMIT_MAX).toBe(300);
  });

  it('parses typed values and lists', () => {
    const env = validateEnv({
      ...SECRETS,
      NODE_ENV: 'production',
      PORT: '8080',
      TRUST_PROXY: 'false',
      LOG_LEVEL: 'debug',
      LOG_PRETTY: 'false',
      CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
    });

    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.LOG_PRETTY).toBe('false');
    expect(env.AUTH_REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(env.CORS_ORIGINS).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('rejects an out-of-range port with a readable error', () => {
    expect(() => validateEnv({ ...SECRETS, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects invalid URLs', () => {
    expect(() => validateEnv({ ...SECRETS, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...SECRETS, CORS_ORIGINS: 'not-a-url' })).toThrow(/CORS_ORIGINS/);
  });

  it('rejects unknown log levels and environments', () => {
    expect(() => validateEnv({ ...SECRETS, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => validateEnv({ ...SECRETS, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('rejects weak secrets and malformed encryption keys', () => {
    expect(() => validateEnv({ ...SECRETS, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() =>
      validateEnv({ ...SECRETS, AUTH_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }),
    ).toThrow(/AUTH_ENCRYPTION_KEY/);
  });
});
