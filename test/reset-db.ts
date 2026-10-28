import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://amrutam:amrutam@localhost:5432/amrutam_test';

if (!/(^|[/_-])test([/_-]|$)/i.test(TEST_DATABASE_URL)) {
  throw new Error(
    'Refusing to reset a database whose URL does not look like a dedicated test database',
  );
}

const childEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64'),
};

const tsx = path.resolve('node_modules/.bin/tsx');

function run(script: string, ...args: string[]): void {
  const result = spawnSync(tsx, [script, ...args], {
    env: childEnv,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to run ${script}`);
  }
}

run('src/database/cli.ts', 'up');

const pool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 1,
  application_name: 'amrutam-test-reset',
});

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> 'schema_migrations'
        ORDER BY tablename`,
    );

    for (const { tablename } of rows) {
      await client.query(`TRUNCATE TABLE "${tablename.replaceAll('"', '""')}" CASCADE`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

run('src/database/seed.ts');
