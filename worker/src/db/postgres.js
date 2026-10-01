import pg from 'pg';
import config from '../config/index.js';
import { logger } from '../lib/logger.js';

// The schema is owned by the API's migrations (server/src/db/migrations);
// the worker only reads and updates deployments and appends logs.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Each running job can hold one extra connection for its project lock.
  max: Math.max(5, config.concurrency * 2 + 1),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  // A query that hangs (lock wait, overloaded server) fails instead of
  // holding a job forever.
  statement_timeout: config.databaseStatementTimeoutMs,
});

pool.on('error', (err) => {
  logger.error('postgres_idle_client_error', { err });
});

// Parameterized queries only: user data goes in `params`, never in `text`.
export function query(text, params) {
  return pool.query(text, params);
}

// Runs `fn` while holding a PostgreSQL advisory lock for the project, so only
// one job at a time decides which deployment of a project is live (promoting
// a healthy deployment, or rolling back an unhealthy one), across worker
// processes too. The lock lives on its own connection and is released when
// `fn` ends, fails, or the connection is lost.
export async function withProjectLock(projectId, fn) {
  const key = `deployx:project:${projectId}`;
  const client = await pool.connect();
  try {
    // Waiting for the lock is waiting for another deployment of the project,
    // which is bounded by its own timeouts: not limited by statement_timeout.
    await client.query("SELECT set_config('statement_timeout', '0', false)");
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    await client.query('RESET statement_timeout');
  } catch (err) {
    client.release(true);
    throw err;
  }

  try {
    return await fn();
  } finally {
    let discard = false;
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    } catch {
      discard = true; // closing the connection releases the lock
    }
    client.release(discard);
  }
}

export async function closePostgres() {
  await pool.end();
}

export default pool;
