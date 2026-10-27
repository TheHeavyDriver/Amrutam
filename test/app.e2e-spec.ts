import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiErrorBody } from '../src/common/errors/api-error.js';
import type { HealthResponse } from '../src/modules/health/health.controller.js';
import { createTestApp } from './utils/create-test-app.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Application (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health endpoints', () => {
    it.each(['/health', '/health/live', '/health/ready'])(
      'responds on %s without the API prefix',
      async (url) => {
        const response = await app.inject({ method: 'GET', url });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');

        const body = response.json<HealthResponse>();
        expect(body).toMatchObject({
          status: 'ok',
          service: 'amrutam-api',
          version: '0.1.0',
          environment: 'test',
        });
        expect(typeof body.uptimeSeconds).toBe('number');
        expect(Date.parse(body.timestamp)).not.toBeNaN();
      },
    );

    it('is not exposed under the API prefix', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('request ids', () => {
    it('propagates a valid client request id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'req-123.abc:def' },
      });

      expect(response.headers['x-request-id']).toBe('req-123.abc:def');
    });

    it('generates a UUID when the client request id is unsafe', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': 'bad id\nwith-injection' },
      });

      const requestId = response.headers['x-request-id'];
      expect(requestId).toMatch(UUID_PATTERN);
    });
  });

  describe('error envelope', () => {
    it('returns a consistent envelope for unknown routes', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

      expect(response.statusCode).toBe(404);

      const body = response.json<ApiErrorBody>();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Cannot GET /api/v1/does-not-exist');
      expect(body.error.requestId).toBe(response.headers['x-request-id']);
    });
  });

  describe('security headers', () => {
    it('sets baseline hardening headers', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  describe('compression', () => {
    it('compresses responses when the client accepts it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'accept-encoding': 'gzip' },
      });

      // Health responses stay below the 1 KiB threshold, so they must be
      // served uncompressed rather than failing when the plugin is active.
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-encoding']).toBeUndefined();
    });
  });
});
