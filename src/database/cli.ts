import 'dotenv/config';
import path from 'node:path';
import { Pool } from 'pg';
import { MigrationRunner } from './migration-runner.js';

const USAGE = `Usage: db <command> [options]

Commands:
  up                 Apply all pending migrations
  down [options]     Roll back the latest migration
    --steps <n>      Roll back n migrations
    --all            Roll back every applied migration
  status             Show applied and pending migrations
`;

function write(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);

  if (command === 'help' || command === '--help' || command === '-h') {
    write(USAGE.trimEnd());
    return;
  }

  if (!['up', 'down', 'status'].includes(command)) {
    writeError(`Unknown command: ${command}\n`);
    writeError(USAGE.trimEnd());
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  let all = false;
  let steps: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--all') {
      all = true;
      continue;
    }

    if (argument === '--steps') {
      const rawSteps = args[index + 1];

      if (!rawSteps || !/^\d+$/.test(rawSteps) || Number(rawSteps) < 1) {
        throw new Error('--steps requires a positive integer');
      }

      steps = Number(rawSteps);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: 'amrutam-migrations',
  });

  const runner = new MigrationRunner(
    pool,
    process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'db/migrations'),
    { logger: (message) => write(`  ${message}`) },
  );

  try {
    if (command === 'up') {
      const applied = await runner.up();
      write(
        applied.length === 0
          ? 'No pending migrations.'
          : `Applied ${applied.length} migration(s): ${applied.map((migration) => migration.version).join(', ')}`,
      );
      return;
    }

    if (command === 'down') {
      const reverted = await runner.down({ all, steps });
      write(
        reverted.length === 0
          ? 'No migrations rolled back.'
          : `Rolled back ${reverted.length} migration(s): ${reverted
              .map((migration) => migration.version)
              .join(', ')}`,
      );
      return;
    }

    const status = await runner.status();

    write(`Applied (${status.applied.length}):`);

    for (const migration of status.applied) {
      write(`  ${migration.version}_${migration.name}  ${migration.appliedAt.toISOString()}`);
    }

    write(`Pending (${status.pending.length}):`);

    for (const migration of status.pending) {
      write(`  ${migration.version}_${migration.name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  writeError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
