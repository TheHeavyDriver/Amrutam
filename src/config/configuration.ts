import type { LogLevel, NodeEnv } from './env.schema.js';
import { validateEnv } from './env.schema.js';

export type AppConfig = {
  nodeEnv: NodeEnv;
  service: {
    name: string;
    version: string;
  };
  http: {
    host: string;
    port: number;
    globalPrefix: string;
    bodyLimitBytes: number;
    trustProxy: boolean;
    corsOrigins: string[];
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
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
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      globalPrefix: env.API_GLOBAL_PREFIX,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
      trustProxy: env.TRUST_PROXY,
      corsOrigins: env.CORS_ORIGINS,
    },
    database: {
      url: env.DATABASE_URL,
    },
    redis: {
      url: env.REDIS_URL,
    },
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY ? env.LOG_PRETTY === 'true' : env.NODE_ENV === 'development',
    },
  };
}
