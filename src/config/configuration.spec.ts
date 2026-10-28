import { describe, expect, it } from 'vitest';
import { loadConfiguration } from './configuration.js';

const SECRETS = {
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-at-least-32-characters',
  JWT_MFA_SECRET: 'test-mfa-secret-that-is-at-least-32-characters',
  AUTH_TOKEN_PEPPER: 'test-pepper-that-is-at-least-32-characters',
  AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PAYMENT_WEBHOOK_SECRET: 'test-payment-webhook-secret-at-least-32-characters',
};

describe('loadConfiguration', () => {
  it('uses pretty logs in development by default', () => {
    const config = loadConfiguration({ ...SECRETS, NODE_ENV: 'development' });

    expect(config.logging.pretty).toBe(true);
  });

  it('uses JSON logs in production by default', () => {
    const config = loadConfiguration({ ...SECRETS, NODE_ENV: 'production' });

    expect(config.logging.pretty).toBe(false);
  });

  it('honours an explicit LOG_PRETTY override', () => {
    const config = loadConfiguration({ ...SECRETS, NODE_ENV: 'production', LOG_PRETTY: 'true' });

    expect(config.logging.pretty).toBe(true);
  });

  it('maps validated environment values into the typed config', () => {
    const config = loadConfiguration({
      ...SECRETS,
      NODE_ENV: 'test',
      PORT: '4000',
      CORS_ORIGINS: 'https://example.com',
    });

    expect(config.nodeEnv).toBe('test');
    expect(config.http.port).toBe(4000);
    expect(config.http.corsOrigins).toEqual(['https://example.com']);
    expect(config.service.name).toBe('amrutam-api');
    expect(config.database.url).toContain('postgresql://');
    expect(config.cache.enabled).toBe(true);
    expect(config.payments.webhookSecret).toContain('webhook');
    expect(config.prescriptions.documentUrlTtlSeconds).toBe(300);
    expect(config.auth.accessTokenTtlSeconds).toBe(900);
    expect(config.auth.secrets.encryptionKey).toBe(SECRETS.AUTH_ENCRYPTION_KEY);
    expect(config.http.rateLimit.max).toBe(300);
  });
});
