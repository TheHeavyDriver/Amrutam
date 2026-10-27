import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { UserRole } from '../../common/auth/auth-user.js';
import type { RequestMetadata } from '../../common/auth/auth-user.js';
import { ApiException } from '../../common/errors/api-exception.js';
import { ErrorCodes } from '../../common/errors/error-codes.js';
import { DatabaseService } from '../../database/database.service.js';

const AUDIT_CHAIN_LOCK_ID = 847_291_337;

export interface AuditRecordInput {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: string;
  resourceType: string;
  resourceId: string;
  request?: RequestMetadata;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AuditChainVerificationResult {
  valid: boolean;
  checkedEntries: number;
  firstInvalidId: string | null;
  checkedAt: string;
}

export interface AuditLogView {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorRole: UserRole | null;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string | null;
  sourceIp: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  metadata: Record<string, unknown>;
  previousHash: string | null;
  entryHash: string;
}

export interface AuditLogListQuery {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface AuditLogPage {
  data: AuditLogView[];
  page: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_role: UserRole | null;
  action: string;
  resource_type: string;
  resource_id: string;
  request_id: string | null;
  source_ip: string | null;
  user_agent: string | null;
  before_hash: string | null;
  after_hash: string | null;
  metadata: Record<string, unknown>;
  previous_hash: string | null;
  entry_hash: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashState(value: unknown): string | null {
  return value === undefined ? null : sha256(stableStringify(value));
}

interface AuditCursorPayload {
  occurredAt: string;
  id: string;
}

function encodeCursor(entry: { occurred_at: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ occurredAt: entry.occurred_at.toISOString(), id: entry.id }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): AuditCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid cursor');
    }

    const record = parsed as Record<string, unknown>;

    if (
      typeof record.occurredAt !== 'string' ||
      typeof record.id !== 'string' ||
      Number.isNaN(Date.parse(record.occurredAt))
    ) {
      throw new Error('Invalid cursor');
    }

    return { occurredAt: record.occurredAt, id: record.id };
  } catch {
    throw new ApiException(HttpStatus.BAD_REQUEST, {
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Invalid audit cursor',
    });
  }
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(input: AuditRecordInput, client?: PoolClient): Promise<string> {
    if (client) {
      return this.append(client, input);
    }

    return this.database.withTransaction((transaction) => this.append(transaction, input));
  }

  async list(query: AuditLogListQuery): Promise<AuditLogPage> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (query.actorId) {
      values.push(query.actorId);
      conditions.push(`actor_id = $${values.length}`);
    }

    if (query.action) {
      values.push(query.action);
      conditions.push(`action = $${values.length}`);
    }

    if (query.resourceType) {
      values.push(query.resourceType);
      conditions.push(`resource_type = $${values.length}`);
    }

    if (query.resourceId) {
      values.push(query.resourceId);
      conditions.push(`resource_id = $${values.length}`);
    }

    if (query.from) {
      values.push(query.from);
      conditions.push(`occurred_at >= $${values.length}`);
    }

    if (query.to) {
      values.push(query.to);
      conditions.push(`occurred_at < $${values.length}`);
    }

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      values.push(new Date(cursor.occurredAt));
      const occurredAtParameter = `$${values.length}`;
      values.push(cursor.id);
      const idParameter = `$${values.length}`;
      conditions.push(
        `(occurred_at < ${occurredAtParameter} OR (occurred_at = ${occurredAtParameter} AND id < ${idParameter}))`,
      );
    }

    values.push(query.limit + 1);
    const limitParameter = `$${values.length}`;
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await this.database.query<AuditRow>(
      `SELECT id, occurred_at, actor_id, actor_role, action, resource_type, resource_id,
              request_id, source_ip, user_agent, before_hash, after_hash, metadata,
              previous_hash, entry_hash
         FROM audit_logs
         ${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ${limitParameter}`,
      values,
    );

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows[pageRows.length - 1];

    return {
      data: pageRows.map((row) => this.toView(row)),
      page: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last) : null,
      },
    };
  }

  async verifyChain(range?: { from?: Date; to?: Date }): Promise<AuditChainVerificationResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (range?.from) {
      values.push(range.from);
      conditions.push(`occurred_at >= $${values.length}`);
    }

    if (range?.to) {
      values.push(range.to);
      conditions.push(`occurred_at < $${values.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await this.database.query<AuditRow>(
      `SELECT id, occurred_at, actor_id, actor_role, action, resource_type, resource_id,
              request_id, source_ip, user_agent, before_hash, after_hash, metadata,
              previous_hash, entry_hash
         FROM audit_logs
         ${where}
        ORDER BY occurred_at ASC, id ASC`,
      values,
    );

    let expectedPreviousHash: string | null = null;

    if (range?.from) {
      const previous = await this.database.query<{ entry_hash: string }>(
        `SELECT entry_hash
           FROM audit_logs
          WHERE occurred_at < $1
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`,
        [range.from],
      );
      expectedPreviousHash = previous.rows[0]?.entry_hash ?? null;
    }

    let checkedEntries = 0;

    for (const row of rows) {
      const occurredAt = row.occurred_at.toISOString();
      const calculatedHash = this.calculateEntryHash({
        id: row.id,
        occurredAt,
        actorId: row.actor_id,
        actorRole: row.actor_role,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        requestId: row.request_id,
        sourceIp: row.source_ip,
        userAgent: row.user_agent,
        beforeHash: row.before_hash,
        afterHash: row.after_hash,
        metadata: row.metadata,
        previousHash: row.previous_hash,
      });

      checkedEntries += 1;

      if (row.previous_hash !== expectedPreviousHash || calculatedHash !== row.entry_hash) {
        return {
          valid: false,
          checkedEntries,
          firstInvalidId: row.id,
          checkedAt: new Date().toISOString(),
        };
      }

      expectedPreviousHash = row.entry_hash;
    }

    return {
      valid: true,
      checkedEntries,
      firstInvalidId: null,
      checkedAt: new Date().toISOString(),
    };
  }

  private async append(client: PoolClient, input: AuditRecordInput): Promise<string> {
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_CHAIN_LOCK_ID]);

    const previous = await client.query<{ entry_hash: string }>(
      `SELECT entry_hash
         FROM audit_logs
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
    );

    const identity = await client.query<{ id: string; occurred_at: Date }>(
      'SELECT uuid_v7() AS id, clock_timestamp() AS occurred_at',
    );

    const identityRow = identity.rows[0];

    if (!identityRow) {
      throw new Error('Failed to allocate audit log identity');
    }

    const occurredAt = identityRow.occurred_at.toISOString();
    const previousHash = previous.rows[0]?.entry_hash ?? null;
    const beforeHash = hashState(input.before);
    const afterHash = hashState(input.after);
    const metadata = input.metadata ?? {};
    const sourceIp = await this.canonicalizeIp(client, input.request?.sourceIp);
    const entryHash = this.calculateEntryHash({
      id: identityRow.id,
      occurredAt,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.request?.requestId ?? null,
      sourceIp,
      userAgent: input.request?.userAgent ?? null,
      beforeHash,
      afterHash,
      metadata,
      previousHash,
    });

    await client.query(
      `INSERT INTO audit_logs (
         id, occurred_at, actor_id, actor_role, action, resource_type, resource_id,
         request_id, source_ip, user_agent, before_hash, after_hash, metadata,
         previous_hash, entry_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        identityRow.id,
        identityRow.occurred_at,
        input.actorId ?? null,
        input.actorRole ?? null,
        input.action,
        input.resourceType,
        input.resourceId,
        input.request?.requestId ?? null,
        sourceIp,
        input.request?.userAgent ?? null,
        beforeHash,
        afterHash,
        metadata,
        previousHash,
        entryHash,
      ],
    );

    return entryHash;
  }

  private async canonicalizeIp(
    client: PoolClient,
    sourceIp: string | undefined,
  ): Promise<string | null> {
    if (!sourceIp) {
      return null;
    }

    try {
      const result = await client.query<{ source_ip: string | null }>(
        'SELECT host($1::inet) AS source_ip',
        [sourceIp],
      );
      return result.rows[0]?.source_ip ?? null;
    } catch {
      return null;
    }
  }

  private toView(row: AuditRow): AuditLogView {
    return {
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      requestId: row.request_id,
      sourceIp: row.source_ip,
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
      metadata: row.metadata,
      previousHash: row.previous_hash,
      entryHash: row.entry_hash,
    };
  }

  private calculateEntryHash(entry: {
    id: string;
    occurredAt: string;
    actorId: string | null;
    actorRole: UserRole | null;
    action: string;
    resourceType: string;
    resourceId: string;
    requestId: string | null;
    sourceIp: string | null;
    userAgent: string | null;
    beforeHash: string | null;
    afterHash: string | null;
    metadata: Record<string, unknown>;
    previousHash: string | null;
  }): string {
    return sha256(
      stableStringify({
        id: entry.id,
        occurredAt: entry.occurredAt,
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        sourceIp: entry.sourceIp,
        userAgent: entry.userAgent,
        beforeHash: entry.beforeHash,
        afterHash: entry.afterHash,
        metadata: entry.metadata,
        previousHash: entry.previousHash,
      }),
    );
  }
}
