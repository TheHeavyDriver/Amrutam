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

  get auth(): AppConfig['auth'] {
    return this.configService.get('auth', { infer: true });
  }

  get logging(): AppConfig['logging'] {
    return this.configService.get('logging', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
}
