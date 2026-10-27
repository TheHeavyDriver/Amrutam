import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;

// Stable advisory lock id shared by every API replica and migration job.
const MIGRATION_LOCK_ID = 72_756_817;

export interface Migration {
  version: string;
  name: string;
  upSql: string;
  downSql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: Migration[];
}

export interface MigrationRunnerOptions {
  logger?: (message: string) => void;
}

interface MigrationFileParts {
  version: string;
  name: string;
  direction: 'up' | 'down';
}

interface MigrationAccumulator {
  name: string;
  upSql?: string;
  downSql?: string;
}

export function parseMigrationFilename(filename: string): MigrationFileParts | null {
  const match = MIGRATION_FILE_PATTERN.exec(filename);
  if (!match) {
    return null;
  }

  const [, version, name, direction] = match;

  if (!version || !name || !direction) {
    return null;
  }

  return { version, name, direction: direction as 'up' | 'down' };
}

export function checksumMigration(upSql: string, downSql: string): string {
  return createHash('sha256').update(upSql).update('\0').update(downSql).digest('hex');
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = new Map<string, MigrationAccumulator>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parts = parseMigrationFilename(entry.name);
    if (!parts) {
      continue;
    }

    const existing = migrations.get(parts.version);

    if (existing && existing.name !== parts.name) {
      throw new Error(
        `Migration ${parts.version} has conflicting names: "${existing.name}" and "${parts.name}"`,
      );
    }

    const accumulator: MigrationAccumulator = existing ?? { name: parts.name };
    const sql = await readFile(path.join(directory, entry.name), 'utf8');

    if (parts.direction === 'up') {
      accumulator.upSql = sql;
    } else {
      accumulator.downSql = sql;
    }

    migrations.set(parts.version, accumulator);
  }

  const result: Migration[] = [];

  for (const [version, migration] of [...migrations.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (migration.upSql === undefined || migration.downSql === undefined) {
      throw new Error(`Migration ${version}_${migration.name} must have both up and down files`);
    }

    result.push({
      version,
      name: migration.name,
      upSql: migration.upSql,
      downSql: migration.downSql,
      checksum: checksumMigration(migration.upSql, migration.downSql),
    });
  }

  return result;
}

export class MigrationRunner {
  private readonly logger: (message: string) => void;

  constructor(
    private readonly pool: Pool,
    private readonly migrationsDirectory = path.resolve(process.cwd(), 'db/migrations'),
    options: MigrationRunnerOptions = {},
  ) {
    this.logger = options.logger ?? (() => undefined);
  }

  async up(): Promise<Migration[]> {
    const migrations = await loadMigrations(this.migrationsDirectory);

    return this.withLock(async (client) => {
      const applied = await this.readApplied(client);
      this.assertChecksums(applied, migrations);

      const appliedVersions = new Set(applied.map((migration) => migration.version));
      const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

      if (pending.length === 0) {
        this.logger('Database schema is up to date.');
        return [];
      }

      const lastApplied = applied.at(-1);
      const firstPending = pending[0];

      if (lastApplied && firstPending && firstPending.version < lastApplied.version) {
        throw new Error(
          `Migration ${firstPending.version} is older than the latest applied migration ` +
            `${lastApplied.version}; migrations must be appended in order`,
        );
      }

      for (const migration of pending) {
        await this.applyUp(client, migration);
      }

      return pending;
    });
  }

  async down(options: { all?: boolean; steps?: number } = {}): Promise<AppliedMigration[]> {
    const migrations = await loadMigrations(this.migrationsDirectory);
    const steps = options.all ? Number.POSITIVE_INFINITY : (options.steps ?? 1);

    if (steps <= 0) {
      throw new Error('Rollback steps must be a positive number');
    }

    return this.withLock(async (client) => {
      const applied = await this.readApplied(client);
      this.assertChecksums(applied, migrations);

      const appliedVersions = new Set(applied.map((migration) => migration.version));
      const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));

      if (pending.length > 0) {
        throw new Error(
          `Cannot roll back while ${pending.length} migration(s) are pending; run migrations up first`,
        );
      }

      const migrationsByVersion = new Map(
        migrations.map((migration) => [migration.version, migration]),
      );
      const toRollback = [...applied].reverse().slice(0, steps);

      if (toRollback.length === 0) {
        this.logger('No migrations to roll back.');
        return [];
      }

      for (const appliedMigration of toRollback) {
        const migration = migrationsByVersion.get(appliedMigration.version);

        if (!migration) {
          throw new Error(`Cannot roll back unknown migration ${appliedMigration.version}`);
        }

        await this.applyDown(client, migration);
      }

      return toRollback;
    });
  }

  async status(): Promise<MigrationStatus> {
    const migrations = await loadMigrations(this.migrationsDirectory);

    return this.withLock(async (client) => {
      const applied = await this.readApplied(client);
      this.assertChecksums(applied, migrations);

      const appliedVersions = new Set(applied.map((migration) => migration.version));

      return {
        applied,
        pending: migrations.filter((migration) => !appliedVersions.has(migration.version)),
      };
    });
  }

  private async applyUp(client: PoolClient, migration: Migration): Promise<void> {
    this.logger(`Applying ${migration.version}_${migration.name}`);

    await client.query('BEGIN');

    try {
      await client.query(migration.upSql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration ${migration.version}_${migration.name} failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async applyDown(client: PoolClient, migration: Migration): Promise<void> {
    this.logger(`Rolling back ${migration.version}_${migration.name}`);

    await client.query('BEGIN');

    try {
      await client.query(migration.downSql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `Rollback of ${migration.version}_${migration.name} failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async withLock<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      await this.ensureMigrationTable(client);
      return await operation(client);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } catch {
        // The connection may already be broken; releasing it closes the session
        // and the database releases the advisory lock with it.
      }

      client.release();
    }
  }

  private async ensureMigrationTable(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  private async readApplied(client: PoolClient): Promise<AppliedMigration[]> {
    const result = await client.query<{
      version: string;
      name: string;
      checksum: string;
      applied_at: Date;
    }>(`
      SELECT version, name, checksum, applied_at
      FROM schema_migrations
      ORDER BY version
    `);

    return result.rows.map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));
  }

  private assertChecksums(applied: AppliedMigration[], migrations: Migration[]): void {
    const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

    for (const appliedMigration of applied) {
      const migration = byVersion.get(appliedMigration.version);

      if (!migration) {
        throw new Error(
          `Migration ${appliedMigration.version}_${appliedMigration.name} is recorded as applied ` +
            'but is missing from disk',
        );
      }

      if (migration.checksum !== appliedMigration.checksum) {
        throw new Error(
          `Checksum mismatch for migration ${migration.version}_${migration.name}; ` +
            'applied migrations must not be edited',
        );
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
