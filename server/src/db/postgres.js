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

export async function pingPostgres() {
  await pool.query('SELECT 1');
}

export async function closePostgres() {
  await pool.end();
}

export default pool;
