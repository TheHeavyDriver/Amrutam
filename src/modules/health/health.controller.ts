import { Controller, Get, Header, HttpStatus, Injectable } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DatabaseService } from '../../database/database.service.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
}

@Injectable()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  check(): HealthResponse {
    return this.buildResponse();
  }

  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): HealthResponse {
    return this.buildResponse();
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<HealthResponse> {
    try {
      await withTimeout(this.database.ping(), 2_000);
    } catch {
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, {
        code: ErrorCodes.SERVICE_UNAVAILABLE,
        message: 'A required dependency is unavailable',
      });
    }

    return this.buildResponse();
  }

  private buildResponse(): HealthResponse {
    return {
      status: 'ok',
      service: this.config.service.name,
      version: this.config.service.version,
      environment: this.config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Dependency check timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
