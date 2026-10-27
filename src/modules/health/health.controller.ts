import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import { AppConfigService } from '../../config/app-config.service.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly config: AppConfigService) {}

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
  ready(): HealthResponse {
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
