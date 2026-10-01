import pg from 'pg';
import config from '../config/index.js';

// A single shared pool for the whole API. The schema itself is managed by
// migrations in ./migrations (npm run migrate).
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
});

// An idle client losing its connection must not crash the process.
pool.on('error', (err) => {
  console.error('[postgres] idle client error:', err.message);
});

// Runs a parameterized query. User input must only ever be passed through
// `params`, never interpolated into `text`.
export function query(text, params) {
  return pool.query(text, params);
}

// Runs `fn(client)` in a transaction on one connection: COMMIT when it
// resolves, ROLLBACK when it throws.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function pingPostgres() {
  await pool.query('SELECT 1');
}

export async function closePostgres() {
  await pool.end();
}

export default pool;
