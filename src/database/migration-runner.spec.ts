import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksumMigration, loadMigrations, parseMigrationFilename } from './migration-runner.js';

describe('parseMigrationFilename', () => {
  it('parses up and down migrations', () => {
    expect(parseMigrationFilename('0001_foundation.up.sql')).toEqual({
      version: '0001',
      name: 'foundation',
      direction: 'up',
    });

    expect(parseMigrationFilename('0012_prescriptions_payments.down.sql')).toEqual({
      version: '0012',
      name: 'prescriptions_payments',
      direction: 'down',
    });
  });

  it.each([
    'README.md',
    '0001_foundation.sql',
    '1_foundation.up.sql',
    '0001_Foundation.up.sql',
    '0001_foundation.up.txt',
    '0001_foundation.up.sql.bak',
  ])('ignores %s', (filename) => {
    expect(parseMigrationFilename(filename)).toBeNull();
  });
});

describe('checksumMigration', () => {
  it('is stable for identical content', () => {
    expect(checksumMigration('select 1;', 'select 1;')).toBe(
      checksumMigration('select 1;', 'select 1;'),
    );
  });

  it('changes when either direction changes', () => {
    const base = checksumMigration('select 1;', 'select 1;');

    expect(checksumMigration('select 2;', 'select 1;')).not.toBe(base);
    expect(checksumMigration('select 1;', 'select 2;')).not.toBe(base);
  });

  it('cannot be confused by content boundaries', () => {
    expect(checksumMigration('a', 'b')).not.toBe(checksumMigration('ab', ''));
  });
});

describe('repository migrations', () => {
  it('loads every migration in version order with both directions', async () => {
    const migrations = await loadMigrations(path.resolve(process.cwd(), 'db/migrations'));

    expect(migrations.map((migration) => migration.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
    ]);

    for (const migration of migrations) {
      expect(migration.name).toMatch(/^[a-z0-9_]+$/);
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.upSql.length).toBeGreaterThan(0);
      expect(migration.downSql.length).toBeGreaterThan(0);
    }
  });
});
