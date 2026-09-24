import { pingPostgres } from '../db/postgres.js';
import { pingRedis } from '../db/redis.js';

const CHECK_TIMEOUT_MS = 3000;

function withTimeout(promise, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} check timed out`)), CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkDependency(name, ping) {
  try {
    await withTimeout(ping(), name);
    return { status: 'connected' };
  } catch (err) {
    return { status: 'disconnected', error: err.message };
  }
}

// Runs the real connectivity checks in parallel. The API is reachable by
// definition if this code is executing.
export async function getSystemStatus() {
  const [database, redis] = await Promise.all([
    checkDependency('PostgreSQL', pingPostgres),
    checkDependency('Redis', pingRedis),
  ]);

  const status = {
    api: 'connected',
    database: database.status,
    redis: redis.status,
    checkedAt: new Date().toISOString(),
  };

  const errors = {};
  if (database.error) errors.database = database.error;
  if (redis.error) errors.redis = redis.error;
  if (Object.keys(errors).length > 0) status.errors = errors;

  const healthy = database.status === 'connected' && redis.status === 'connected';

  return { healthy, status };
}
