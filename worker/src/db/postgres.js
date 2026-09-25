import pg from 'pg';
import config from '../config/index.js';

// The schema is owned by the API's migrations (server/src/db/migrations);
// the worker only reads and updates deployments and appends logs.
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[worker] postgres idle client error:', err.message);
});

// Parameterized queries only: user data goes in `params`, never in `text`.
export function query(text, params) {
  return pool.query(text, params);
}

export async function closePostgres() {
  await pool.end();
}

export default pool;
