import type { LogLevel, NodeEnv } from './env.schema.js';
import { validateEnv } from './env.schema.js';

export type AppConfig = {
  nodeEnv: NodeEnv;
  service: {
    name: string;
    version: string;
    publicUrl: string;
  };
  http: {
    host: string;
    port: number;
    globalPrefix: string;
    bodyLimitBytes: number;
    trustProxy: boolean;
    corsOrigins: string[];
    rateLimit: {
      max: number;
      windowSeconds: number;
    };
  };
  database: {
    url: string;
    poolMax: number;
  };
  redis: {
    url: string;
  };
  auth: {
    accessTokenTtlSeconds: number;
    mfaTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    emailVerificationTtlSeconds: number;
    passwordResetTtlSeconds: number;
    requireEmailVerification: boolean;
    maxLoginAttempts: number;
    lockoutSeconds: number;
    secrets: {
      accessToken: string;
      mfaToken: string;
      tokenPepper: string;
      encryptionKey: string;
    };
  };
  logging: {
    level: LogLevel;
    pretty: boolean;
  };
};

export const SERVICE_NAME = 'amrutam-api';

export function loadConfiguration(rawEnv: Record<string, unknown> = process.env): AppConfig {
  const env = validateEnv(rawEnv);

  return {
    nodeEnv: env.NODE_ENV,
    service: {
      name: SERVICE_NAME,
      version: env.APP_VERSION,
      publicUrl: env.APP_PUBLIC_URL,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      globalPrefix: env.API_GLOBAL_PREFIX,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
      trustProxy: env.TRUST_PROXY,
      corsOrigins: env.CORS_ORIGINS,
      rateLimit: {
        max: env.RATE_LIMIT_MAX,
        windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      },
    },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
    },
    redis: {
      url: env.REDIS_URL,
    },
    auth: {
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      mfaTokenTtlSeconds: env.AUTH_MFA_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      emailVerificationTtlSeconds: env.AUTH_EMAIL_VERIFICATION_TTL_SECONDS,
      passwordResetTtlSeconds: env.AUTH_PASSWORD_RESET_TTL_SECONDS,
      requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      maxLoginAttempts: env.AUTH_MAX_LOGIN_ATTEMPTS,
      lockoutSeconds: env.AUTH_LOCKOUT_SECONDS,
      secrets: {
        accessToken: env.JWT_ACCESS_SECRET,
        mfaToken: env.JWT_MFA_SECRET,
        tokenPepper: env.AUTH_TOKEN_PEPPER,
        encryptionKey: env.AUTH_ENCRYPTION_KEY,
      },
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY ? env.LOG_PRETTY === 'true' : env.NODE_ENV === 'development',
    },
  };
}
