process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-characters';
process.env.JWT_MFA_SECRET = 'test-mfa-secret-that-is-at-least-32-characters';
process.env.AUTH_TOKEN_PEPPER = 'test-pepper-that-is-at-least-32-characters';
process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PAYMENT_WEBHOOK_SECRET = 'test-payment-webhook-secret-at-least-32-characters';
process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.RATE_LIMIT_MAX = '10000';
process.env.CACHE_ENABLED = 'false';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://amrutam:amrutam@localhost:5432/amrutam_test';
