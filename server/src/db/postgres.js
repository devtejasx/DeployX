import pg from 'pg';
import config from '../config/index.js';

// A single shared pool for the whole API. No schema is created in Phase 1;
// the pool is only used to verify connectivity.
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

export async function pingPostgres() {
  await pool.query('SELECT 1');
}

export async function closePostgres() {
  await pool.end();
}

export default pool;
