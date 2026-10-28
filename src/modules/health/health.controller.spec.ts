import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service.js';
import type { DatabaseService } from '../../database/database.service.js';
import { HealthController } from './health.controller.js';

const config = {
  service: { name: 'amrutam-api', version: '0.1.0' },
  nodeEnv: 'test',
} as AppConfigService;

describe('HealthController', () => {
  it('reports ready when PostgreSQL responds', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const database = { ping } as unknown as DatabaseService;
    const controller = new HealthController(config, database);

    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ok',
      service: 'amrutam-api',
      environment: 'test',
    });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('returns 503 when PostgreSQL is unavailable', async () => {
    const database = {
      ping: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as DatabaseService;
    const controller = new HealthController(config, database);

    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      response: { code: 'SERVICE_UNAVAILABLE' },
    });
  });
});
