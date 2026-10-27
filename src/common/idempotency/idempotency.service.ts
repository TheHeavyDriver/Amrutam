import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service.js';
import type { AuthenticatedUser, RequestMetadata } from '../auth/auth-user.js';
import { ApiException } from '../errors/api-exception.js';
import { ErrorCodes } from '../errors/error-codes.js';

interface IdempotencyRow {
  request_method: string;
  request_path: string;
  request_hash: string;
  status: 'in_progress' | 'completed' | 'failed';
  response_status: number | null;
  response_body: unknown;
  expires_at: Date;
}

export interface IdempotentExecutionInput {
  actor: AuthenticatedUser;
  key: string | undefined;
  method: string;
  path: string;
  body: unknown;
  request: RequestMetadata;
}

export interface IdempotentExecutionResult<Value> {
  status: number;
  body: Value;
  replayed: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  async execute<Value>(
    input: IdempotentExecutionInput,
    work: (client: PoolClient) => Promise<{ status: number; body: Value }>,
  ): Promise<IdempotentExecutionResult<Value>> {
    const key = input.key?.trim() ?? '';

    if (!/^[A-Za-z0-9._:-]{8,255}$/.test(key)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Idempotency-Key header is required and must be 8-255 safe characters',
      });
    }

    const requestHash = createHash('sha256')
      .update(
        stableStringify({
          method: input.method,
          path: input.path,
          body: input.body,
        }),
      )
      .digest('hex');

    return this.database.withTransaction(async (client) => {
      // Serialize concurrent requests with the same actor/key. The first
      // transaction either completes with the stored response or rolls back
      // entirely, so retries never observe an orphaned business write.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
        `${input.actor.id}:${key}`,
      ]);

      const existing = await client.query<IdempotencyRow>(
        `SELECT request_method, request_path, request_hash, status,
                response_status, response_body, expires_at
           FROM idempotency_keys
          WHERE actor_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [input.actor.id, key],
      );
      const record = existing.rows[0];

      if (record && record.expires_at > new Date()) {
        if (
          record.request_method !== input.method ||
          record.request_path !== input.path ||
          record.request_hash !== requestHash
        ) {
          throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
            code: ErrorCodes.IDEMPOTENCY_KEY_REUSED,
            message: 'This Idempotency-Key was already used for a different request',
          });
        }

        if (record.status === 'completed') {
          return {
            status: record.response_status ?? 200,
            body: record.response_body as Value,
            replayed: true,
          };
        }

        if (record.status === 'in_progress') {
          throw new ApiException(HttpStatus.CONFLICT, {
            code: ErrorCodes.IDEMPOTENCY_IN_PROGRESS,
            message: 'A request with this Idempotency-Key is already in progress',
            retryAfterSeconds: 1,
          });
        }
      }

      if (record) {
        await client.query(
          `UPDATE idempotency_keys
              SET request_method = $3,
                  request_path = $4,
                  request_hash = $5,
                  status = 'in_progress',
                  response_status = NULL,
                  response_body = NULL,
                  locked_until = now() + interval '30 seconds',
                  expires_at = now() + interval '24 hours'
            WHERE actor_id = $1 AND idempotency_key = $2`,
          [input.actor.id, key, input.method, input.path, requestHash],
        );
      } else {
        await client.query(
          `INSERT INTO idempotency_keys (
             actor_id, idempotency_key, request_method, request_path,
             request_hash, status, locked_until
           ) VALUES ($1, $2, $3, $4, $5, 'in_progress', now() + interval '30 seconds')`,
          [input.actor.id, key, input.method, input.path, requestHash],
        );
      }

      const result = await work(client);

      await client.query(
        `UPDATE idempotency_keys
            SET status = 'completed',
                response_status = $3,
                response_body = $4,
                locked_until = NULL
          WHERE actor_id = $1 AND idempotency_key = $2`,
        [input.actor.id, key, result.status, result.body],
      );

      return { status: result.status, body: result.body, replayed: false };
    });
  }
}
