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
  databaseUrl: process.env.DATABASE_URL || 'postgresql://deployx:deployx@localhost:5432/deployx',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Must match server/src/queues/deploymentQueue.js and the API's QUEUE_PREFIX.
  queue: {
    name: 'deployments',
    jobName: 'deploy',
    prefix: process.env.QUEUE_PREFIX || 'deployx',
  },

  // How many deployment jobs this worker process runs at the same time.
  concurrency: positiveInt(process.env.WORKER_CONCURRENCY, 2),

  // How long a graceful shutdown waits for running jobs before forcing it.
  shutdownTimeoutMs: positiveInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS, 25000),

  // SIMULATION (Phase 3 only): duration of each simulated stage.
  simulation: {
    stepMs: positiveInt(process.env.SIMULATION_STEP_MS, 2000),
  },
};

export default config;
