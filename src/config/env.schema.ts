import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const booleanFromString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const requiredSecret = z
  .string()
  .min(32, 'must be at least 32 characters')
  .max(512, 'must be at most 512 characters');

const encryptionKey = z.string().refine(
  (value) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      return false;
    }

    return Buffer.from(value, 'base64').length === 32;
  },
  { message: 'must be a base64-encoded 32-byte key' },
);

export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_VERSION: z.string().min(1).default('0.1.0'),

  API_GLOBAL_PREFIX: z.string().min(1).default('api/v1'),
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),
  TRUST_PROXY: booleanFromString('true'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3001,http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(z.url()).max(20)),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: z.enum(['true', 'false']).optional(),

  DATABASE_URL: z.url().default('postgresql://amrutam:amrutam@localhost:5432/amrutam'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  CACHE_ENABLED: booleanFromString('true'),

  APP_PUBLIC_URL: z.url().default('http://localhost:3000'),

  // Secrets intentionally have no defaults: a missing key must fail startup
  // rather than silently use a well-known development value in production.
  JWT_ACCESS_SECRET: requiredSecret,
  JWT_MFA_SECRET: requiredSecret,
  AUTH_TOKEN_PEPPER: requiredSecret,
  AUTH_ENCRYPTION_KEY: encryptionKey,

  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  AUTH_MFA_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(1_800).default(300),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(31_536_000)
    .default(2_592_000),
  AUTH_EMAIL_VERIFICATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(604_800)
    .default(86_400),
  AUTH_PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().min(300).max(7_200).default(3_600),
  AUTH_REQUIRE_EMAIL_VERIFICATION: booleanFromString('true'),
  AUTH_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  AUTH_LOCKOUT_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),

  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(10_000).default(300),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
