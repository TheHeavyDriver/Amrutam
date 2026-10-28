import 'dotenv/config';
import { Pool } from 'pg';

const USAGE = `Usage: jobs <command> [options]

Commands:
  status [--limit <n>]        Show outbox backlog and dead-letter events
  replay --id <uuid>          Requeue a dead-letter event
  replay --all [--limit <n>]  Requeue dead-letter events (max 1000)
  replay --status <s>         Filter replay by dead_letter or failed (default: dead_letter)
`;

interface CountRow {
  status: string;
  count: string;
  oldest: Date | null;
}

async function main(): Promise<void> {
  const [command = 'status', ...args] = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  if (!['status', 'replay'].includes(command)) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    if (command === 'status') {
      await status(pool, option(args, '--limit') ?? '10');
      return;
    }

    await replay(pool, args);
  } finally {
    await pool.end();
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function status(pool: Pool, limitInput: string): Promise<void> {
  const limit = Math.min(Math.max(Number(limitInput) || 10, 1), 100);
  const counts = await pool.query<CountRow>(
    `SELECT status::text AS status,
            count(*)::text AS count,
            min(created_at) AS oldest
       FROM outbox_events
      GROUP BY status
      ORDER BY status`,
  );
  const deadLetters = await pool.query<{
    id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    attempts: number;
    last_error: string | null;
    created_at: Date;
  }>(
    `SELECT id, event_type, aggregate_type, aggregate_id, attempts, last_error, created_at
       FROM outbox_events
      WHERE status = 'dead_letter'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        counts: counts.rows.map((row) => ({
          status: row.status,
          count: Number(row.count),
          oldest: row.oldest?.toISOString() ?? null,
        })),
        deadLetters: deadLetters.rows.map((row) => ({
          ...row,
          created_at: row.created_at.toISOString(),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function replay(pool: Pool, args: string[]): Promise<void> {
  const id = option(args, '--id');
  const all = args.includes('--all');
  const status = option(args, '--status') ?? 'dead_letter';
  const limit = Math.min(Math.max(Number(option(args, '--limit')) || 100, 1), 1_000);

  if (!id && !all) {
    throw new Error('Pass --id <uuid> or --all to replay events');
  }

  if (!['dead_letter', 'failed'].includes(status)) {
    throw new Error('Replay status must be dead_letter or failed');
  }

  const result = await pool.query<{ id: string }>(
    `UPDATE outbox_events
        SET status = 'pending',
            attempts = 0,
            available_at = now(),
            locked_at = NULL,
            locked_by = NULL,
            dispatched_at = NULL,
            last_error = NULL
      WHERE status = $1::outbox_status
        ${id ? 'AND id = $3::uuid' : ''}
        AND id IN (
          SELECT id
            FROM outbox_events
           WHERE status = $1::outbox_status
           ORDER BY created_at ASC
           LIMIT $2
        )
      RETURNING id`,
    id ? [status, limit, id] : [status, limit],
  );

  process.stdout.write(
    `${JSON.stringify({ replayed: result.rowCount, ids: result.rows.map((row) => row.id) }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  console.error('Jobs command failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
