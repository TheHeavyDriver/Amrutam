import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Operation {
  operationId?: string;
  security?: unknown[];
  parameters?: Array<{ $ref?: string }>;
  tags?: string[];
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: {
    parameters: Record<
      string,
      { name?: string; required?: boolean; schema?: Record<string, unknown> }
    >;
    schemas: Record<string, unknown>;
  };
}

const document = parse(
  readFileSync(path.resolve(process.cwd(), 'openapi/openapi.yaml'), 'utf8'),
) as OpenApiDocument;

const EXPECTED_OPERATIONS: Array<[string, string]> = [
  ['get', '/health'],
  ['get', '/health/live'],
  ['get', '/health/ready'],
  ['post', '/api/v1/auth/register'],
  ['post', '/api/v1/auth/login'],
  ['post', '/api/v1/auth/refresh'],
  ['post', '/api/v1/auth/logout'],
  ['post', '/api/v1/auth/verify-email'],
  ['post', '/api/v1/auth/resend-verification'],
  ['post', '/api/v1/auth/forgot-password'],
  ['post', '/api/v1/auth/reset-password'],
  ['post', '/api/v1/auth/mfa/verify'],
  ['post', '/api/v1/auth/mfa/setup'],
  ['post', '/api/v1/auth/mfa/enable'],
  ['post', '/api/v1/auth/mfa/disable'],
  ['get', '/api/v1/users/me'],
  ['patch', '/api/v1/users/me'],
  ['post', '/api/v1/users/me/password'],
  ['get', '/api/v1/doctors'],
  ['get', '/api/v1/doctors/{doctorId}'],
  ['get', '/api/v1/doctors/{doctorId}/availability'],
  ['get', '/api/v1/doctors/me/availability'],
  ['post', '/api/v1/doctors/me/availability'],
  ['delete', '/api/v1/doctors/me/availability/{slotId}'],
  ['post', '/api/v1/bookings'],
  ['get', '/api/v1/bookings'],
  ['get', '/api/v1/bookings/{consultationId}'],
  ['post', '/api/v1/bookings/{consultationId}/cancel'],
  ['post', '/api/v1/bookings/{consultationId}/reschedule'],
  ['post', '/api/v1/bookings/{consultationId}/join-token'],
  ['post', '/api/v1/bookings/{consultationId}/start'],
  ['post', '/api/v1/bookings/{consultationId}/complete'],
  ['post', '/api/v1/bookings/{consultationId}/no-show'],
  ['post', '/api/v1/bookings/{consultationId}/payments'],
  ['get', '/api/v1/bookings/{consultationId}/payments'],
  ['get', '/api/v1/payments/{paymentId}'],
  ['post', '/api/v1/payments/{paymentId}/confirm'],
  ['post', '/api/v1/payments/{paymentId}/refund'],
  ['post', '/api/v1/webhooks/payments/{provider}'],
  ['post', '/api/v1/bookings/{consultationId}/prescriptions'],
  ['get', '/api/v1/bookings/{consultationId}/prescriptions'],
  ['get', '/api/v1/prescriptions/{prescriptionId}'],
  ['patch', '/api/v1/prescriptions/{prescriptionId}'],
  ['post', '/api/v1/prescriptions/{prescriptionId}/sign'],
  ['post', '/api/v1/prescriptions/{prescriptionId}/void'],
  ['get', '/api/v1/prescriptions/{prescriptionId}/document'],
  ['get', '/api/v1/prescriptions/{prescriptionId}/document/content'],
  ['get', '/api/v1/admin/doctors'],
  ['patch', '/api/v1/admin/doctors/{doctorId}/verification'],
  ['get', '/api/v1/admin/analytics/overview'],
  ['get', '/api/v1/admin/analytics/consultations'],
  ['get', '/api/v1/admin/analytics/revenue'],
  ['get', '/api/v1/admin/analytics/doctor-utilization'],
  ['get', '/api/v1/admin/analytics/specialties'],
  ['get', '/api/v1/admin/audit-logs'],
  ['get', '/api/v1/admin/audit-logs/verify'],
];

const PUBLIC_OPERATIONS = new Set([
  'get /health',
  'get /health/live',
  'get /health/ready',
  'post /api/v1/auth/register',
  'post /api/v1/auth/login',
  'post /api/v1/auth/refresh',
  'post /api/v1/auth/verify-email',
  'post /api/v1/auth/resend-verification',
  'post /api/v1/auth/forgot-password',
  'post /api/v1/auth/reset-password',
  'post /api/v1/auth/mfa/verify',
  'get /api/v1/doctors',
  'get /api/v1/doctors/{doctorId}',
  'get /api/v1/doctors/{doctorId}/availability',
  'get /api/v1/prescriptions/{prescriptionId}/document/content',
]);

const IDEMPOTENT_OPERATIONS: Array<[string, string]> = [
  ['post', '/api/v1/doctors/me/availability'],
  ['delete', '/api/v1/doctors/me/availability/{slotId}'],
  ['post', '/api/v1/bookings'],
  ['post', '/api/v1/bookings/{consultationId}/cancel'],
  ['post', '/api/v1/bookings/{consultationId}/reschedule'],
  ['post', '/api/v1/bookings/{consultationId}/start'],
  ['post', '/api/v1/bookings/{consultationId}/complete'],
  ['post', '/api/v1/bookings/{consultationId}/no-show'],
  ['post', '/api/v1/bookings/{consultationId}/payments'],
  ['post', '/api/v1/payments/{paymentId}/confirm'],
  ['post', '/api/v1/payments/{paymentId}/refund'],
  ['post', '/api/v1/bookings/{consultationId}/prescriptions'],
  ['patch', '/api/v1/prescriptions/{prescriptionId}'],
  ['post', '/api/v1/prescriptions/{prescriptionId}/sign'],
  ['post', '/api/v1/prescriptions/{prescriptionId}/void'],
  ['patch', '/api/v1/admin/doctors/{doctorId}/verification'],
];

function operationId(method: string, route: string): Operation {
  const operation = document.paths[route]?.[method];
  expect(operation, `${method.toUpperCase()} ${route} is missing`).toBeDefined();
  return operation as Operation;
}

describe('OpenAPI contract', () => {
  it('is an OpenAPI 3.1 document', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('covers every planned operation', () => {
    for (const [method, route] of EXPECTED_OPERATIONS) {
      operationId(method, route);
    }

    const declared = Object.entries(document.paths).flatMap(([route, methods]) =>
      Object.keys(methods).map((method) => `${method} ${route}`),
    );

    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toHaveLength(EXPECTED_OPERATIONS.length);
  });

  it('gives every operation a unique operationId and a tag', () => {
    const ids = EXPECTED_OPERATIONS.map(([method, route]) => {
      const operation = operationId(method, route);
      expect(operation.operationId).toBeTruthy();
      expect(operation.tags?.length).toBeGreaterThan(0);
      return operation.operationId;
    });

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks public probes and auth entry points as unauthenticated', () => {
    for (const [method, route] of EXPECTED_OPERATIONS) {
      const operation = operationId(method, route);
      const key = `${method} ${route}`;

      if (PUBLIC_OPERATIONS.has(key)) {
        expect(operation.security, key).toEqual([]);
      } else if (method === 'post' && route === '/api/v1/webhooks/payments/{provider}') {
        expect(operation.security, key).toEqual([{ webhookSignature: [] }]);
      } else {
        expect(operation.security ?? [{ bearerAuth: [] }], key).toContainEqual({
          bearerAuth: [],
        });
      }
    }
  });

  it('requires an idempotency key on unsafe availability, clinical, and payment writes', () => {
    for (const [method, route] of IDEMPOTENT_OPERATIONS) {
      const parameters = operationId(method, route).parameters ?? [];
      const hasIdempotencyKey = parameters.some(
        (parameter) => parameter.$ref === '#/components/parameters/IdempotencyKey',
      );

      expect(hasIdempotencyKey, `${method.toUpperCase()} ${route}`).toBe(true);
    }
  });

  it('defines bounded idempotency keys and the shared error envelope', () => {
    const idempotency = document.components.parameters.IdempotencyKey;

    expect(idempotency).toMatchObject({
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', minLength: 8, maxLength: 255 },
    });

    expect(document.components.schemas.ErrorResponse).toMatchObject({
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          required: ['code', 'message', 'requestId'],
        },
      },
    });
  });

  it('ships a generated TypeScript client for the contract', () => {
    const client = readFileSync(
      path.resolve(process.cwd(), 'clients/typescript/generated/api.ts'),
      'utf8',
    );

    expect(client).toContain('DO NOT MODIFY');
    expect(client).toContain('export function createBooking');
    expect(client).toContain('export type Consultation');
    expect(client).toContain('export type Prescription');
  });
});
