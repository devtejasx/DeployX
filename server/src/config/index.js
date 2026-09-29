import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repository-root .env when running outside Docker. Docker Compose
// injects variables directly, so a missing file is expected there.
const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  process.loadEnvFile(rootEnvPath);
} catch {
  // No .env file - rely on the process environment.
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://deployx:deployx@localhost:5432/deployx',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // BullMQ deployment queue. The worker must use the same prefix.
  queue: {
    prefix: process.env.QUEUE_PREFIX || 'deployx',
    // Total tries per deployment job, including the first one.
    attempts: positiveInt(process.env.DEPLOYMENT_JOB_ATTEMPTS, 3),
    // Exponential backoff base: retries wait base, 2 x base, 4 x base, ...
    backoffMs: positiveInt(process.env.DEPLOYMENT_JOB_BACKOFF_MS, 2000),
  },
  // Live log streams (SSE): how often each stream re-checks the database in
  // case a Redis event was missed, and how often it sends a keep-alive.
  logStream: {
    pollMs: positiveInt(process.env.LOG_STREAM_POLL_MS, 2000),
    heartbeatMs: positiveInt(process.env.LOG_STREAM_HEARTBEAT_MS, 15000),
  },
  // Temporary stand-in for authentication (see middleware/devUser.js).
  devUser: {
    email: (process.env.DEV_USER_EMAIL || 'dev@deployx.local').toLowerCase(),
    name: process.env.DEV_USER_NAME || 'DeployX Developer',
  },
};

export default config;
