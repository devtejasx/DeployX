import os from 'node:os';
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

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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

  // Per-deployment scratch space for cloned sources, removed after each job.
  workspace: {
    root: path.resolve(process.env.WORKSPACE_ROOT || path.join(os.tmpdir(), 'deployx-workspaces')),
    // Workspaces older than this are leftovers of a killed worker.
    staleAfterMs: positiveInt(process.env.WORKSPACE_STALE_AFTER_MS, 60 * 60 * 1000),
  },

  git: {
    timeoutMs: positiveInt(process.env.GIT_TIMEOUT_MS, 2 * 60 * 1000),
  },

  docker: {
    // Image repository prefix: <prefix>/<project-slug>-<project-id>:<commit>
    imagePrefix: process.env.DOCKER_IMAGE_PREFIX || 'deployx',
    // Network deployed apps are attached to (created on demand).
    appNetwork: process.env.DEPLOYX_APP_NETWORK || 'deployx-apps',
    buildTimeoutMs: positiveInt(process.env.DOCKER_BUILD_TIMEOUT_MS, 10 * 60 * 1000),
    commandTimeoutMs: positiveInt(process.env.DOCKER_COMMAND_TIMEOUT_MS, 60 * 1000),
    // How long a new container must stay running to count as started.
    startupGraceMs: positiveInt(process.env.CONTAINER_STARTUP_GRACE_MS, 3000),
    // Resource limits for deployed apps.
    appMemory: process.env.APP_MEMORY_LIMIT || '512m',
    appCpus: process.env.APP_CPU_LIMIT || '1',
    appPidsLimit: positiveInt(process.env.APP_PIDS_LIMIT, 256),
    // Build output stored per attempt (see lib/buildLog.js).
    buildLogMaxLines: positiveInt(process.env.BUILD_LOG_MAX_LINES, 150),
  },

  // HTTP health checks of deployed apps: GET http://<host>:<port><path>.
  // The path is set per project (projects.health_check_path, "/health" by
  // default) and the port is the host port Docker published the project's
  // container_port on; the rest applies to every deployment.
  healthCheck: {
    // Where published container ports are reachable from the worker:
    // 127.0.0.1 on the Docker host, host.docker.internal in Docker Compose.
    host: process.env.HEALTH_CHECK_HOST || '127.0.0.1',
    // How long one request may take.
    timeoutMs: positiveInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 2000),
    // Pause between two attempts.
    intervalMs: positiveInt(process.env.HEALTH_CHECK_INTERVAL_MS, 2000),
    // Attempts before the deployment counts as unhealthy.
    retries: positiveInt(process.env.HEALTH_CHECK_RETRIES, 5),
    // Time the application gets to start before the first attempt.
    startupGraceMs: nonNegativeInt(process.env.HEALTH_CHECK_STARTUP_GRACE_MS, 5000),
  },
};

export default config;
