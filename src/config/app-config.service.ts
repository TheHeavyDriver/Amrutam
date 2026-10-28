import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from './configuration.js';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  get nodeEnv(): AppConfig['nodeEnv'] {
    return this.configService.get('nodeEnv', { infer: true });
  }

  get service(): AppConfig['service'] {
    return this.configService.get('service', { infer: true });
  }

  get http(): AppConfig['http'] {
    return this.configService.get('http', { infer: true });
  }

  get database(): AppConfig['database'] {
    return this.configService.get('database', { infer: true });
  }

  get cache(): AppConfig['cache'] {
    return this.configService.get('cache', { infer: true });
  }

  get redis(): AppConfig['redis'] {
    return this.configService.get('redis', { infer: true });
  }

  get payments(): AppConfig['payments'] {
    return this.configService.get('payments', { infer: true });
  }

  get prescriptions(): AppConfig['prescriptions'] {
    return this.configService.get('prescriptions', { infer: true });
  }

  get auth(): AppConfig['auth'] {
    return this.configService.get('auth', { infer: true });
  }

  get logging(): AppConfig['logging'] {
    return this.configService.get('logging', { infer: true });
  }

  get jobs(): AppConfig['jobs'] {
    return this.configService.get('jobs', { infer: true });
  }

  get tracing(): AppConfig['tracing'] {
    return this.configService.get('tracing', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
