import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runner } from 'node-pg-migrate';
import config from '../config/index.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Applies (up) or reverts (down) SQL migrations from src/db/migrations.
// Applied migrations are recorded in the `pgmigrations` table, and a Postgres
// advisory lock stops two processes from migrating at the same time.
export async function runMigrations({
  direction = 'up',
  count,
  databaseUrl = config.databaseUrl,
  log = console.log,
} = {}) {
  return runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction,
    // Down reverts one migration at a time unless a count is given.
    count: count ?? (direction === 'down' ? 1 : Infinity),
    checkOrder: true,
    log,
  });
}

// CLI: node src/db/migrate.js up|down [count]
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [direction = 'up', countArg] = process.argv.slice(2);

  if (direction !== 'up' && direction !== 'down') {
    console.error('Usage: node src/db/migrate.js up|down [count]');
    process.exit(1);
  }

  const count = countArg === undefined ? undefined : Number(countArg);
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
    console.error('count must be a positive integer');
    process.exit(1);
  }

  try {
    const applied = await runMigrations({ direction, count });
    console.log(
      applied.length === 0
        ? '[migrate] Nothing to migrate'
        : `[migrate] ${direction === 'up' ? 'Applied' : 'Reverted'} ${applied.length} migration(s)`,
    );
  } catch (err) {
    // Connection failures arrive as an AggregateError with an empty message.
    console.error('[migrate] Migration failed:', err.message || err.code || err);
    process.exit(1);
  }
}
