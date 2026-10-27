import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_URL).toBe('postgresql://amrutam:amrutam@localhost:5432/amrutam');
    expect(env.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('parses typed values and lists', () => {
    const env = validateEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      TRUST_PROXY: 'false',
      LOG_LEVEL: 'debug',
      LOG_PRETTY: 'false',
      CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
    });

    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.LOG_PRETTY).toBe('false');
    expect(env.CORS_ORIGINS).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('rejects an out-of-range port with a readable error', () => {
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects invalid URLs', () => {
    expect(() => validateEnv({ DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ CORS_ORIGINS: 'not-a-url' })).toThrow(/CORS_ORIGINS/);
  });

  it('rejects unknown log levels and environments', () => {
    expect(() => validateEnv({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
