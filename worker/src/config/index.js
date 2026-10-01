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

  // Liveness in Redis (services/heartbeat.js): how often the worker reports.
  heartbeat: {
    intervalMs: positiveInt(process.env.HEARTBEAT_INTERVAL_MS, 10000),
  },

  // GET /health, /ready and /metrics of the worker (monitoringServer.js).
  // WORKER_METRICS_PORT=off disables it. METRICS_TOKEN is shared with the API.
  monitoring: {
    port: ['off', 'false'].includes(process.env.WORKER_METRICS_PORT)
      ? null
      : nonNegativeInt(process.env.WORKER_METRICS_PORT, 9464),
    host: process.env.WORKER_METRICS_HOST || '127.0.0.1',
    token: process.env.METRICS_TOKEN || '',
  },

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

  // GitHub App used to clone private repositories (optional). The worker signs
  // a short-lived JWT with the App's private key and exchanges it for an
  // installation token that can only read the one repository being deployed,
  // and expires within an hour. Without an App, only public repositories can
  // be cloned. The private key may be given with literal "\n" line breaks.
  github: {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },

  // AWS deployments (projects with deployment target AWS_ECS): images are
  // pushed to one ECR repository and deployed to the project's ECS service in
  // one cluster. Credentials are never configured here: the AWS SDK finds them
  // in its usual places (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE,
  // or the IAM role of the machine or task the worker runs on).
  aws: {
    region: process.env.AWS_REGION || '',
    ecrRepository: process.env.AWS_ECR_REPOSITORY || '',
    ecsCluster: process.env.AWS_ECS_CLUSTER || '',
    // How long an ECS rollout may take before it counts as failed, and how
    // often its progress is checked.
    deployTimeoutMs: positiveInt(process.env.AWS_ECS_DEPLOY_TIMEOUT_MS, 10 * 60 * 1000),
    pollIntervalMs: positiveInt(process.env.AWS_ECS_POLL_INTERVAL_MS, 10 * 1000),
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
    // AWS_ECS projects are checked on their service URL, whose host must
    // resolve to a public address. Set to true when the service is only
    // reachable privately (an internal load balancer, the worker running in
    // the same VPC). Link-local addresses such as the instance metadata
    // service (169.254.169.254) stay refused either way.
    allowPrivateUrls: process.env.HEALTH_CHECK_ALLOW_PRIVATE_URLS === 'true',
  },
};

export default config;
