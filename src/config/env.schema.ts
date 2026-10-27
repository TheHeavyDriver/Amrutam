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
  REDIS_URL: z.url().default('redis://localhost:6379'),
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
