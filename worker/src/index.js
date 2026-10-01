// DeployX worker entry point: consumes jobs from the "deployments" queue.
import config from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { logger } from './lib/logger.js';
import { runCommand } from './lib/exec.js';
import { startMonitoringServer } from './monitoringServer.js';
import { startHeartbeat } from './services/heartbeat.js';
import { createRecoveryService } from './services/recoveryService.js';
import { sweepStaleWorkspaces } from './services/workspace.js';
import { createDeploymentWorker } from './worker.js';

const { worker, connection, close, activeJobs } = createDeploymentWorker();

let shuttingDown = false;
const heartbeat = startHeartbeat({ connection, getActiveJobs: activeJobs });
// Job changes are reported at once, not only at the next interval.
for (const event of ['active', 'completed', 'failed']) worker.on(event, () => heartbeat.beat());
const monitoring = startMonitoringServer({ worker, connection, isStopping: () => shuttingDown });
const recovery = createRecoveryService({ connection });

// Graceful shutdown: stop taking new jobs (the heartbeat says "stopping"),
// let running jobs finish, then close Redis and PostgreSQL. If running jobs
// take longer than WORKER_SHUTDOWN_TIMEOUT_MS, exit anyway: their locks
// expire, BullMQ treats them as stalled and hands them to the next worker,
// which resumes them from the status they were left in (deploymentProcessor.js).
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('worker_stopping', { signal, activeJobs: activeJobs(), workerId: heartbeat.workerId });

  const forceExit = setTimeout(() => {
    logger.error('worker_shutdown_timeout', {
      timeoutMs: config.shutdownTimeoutMs,
      msg: 'running jobs did not finish in time; they will be picked up again when a worker starts',
    });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await heartbeat.markStopping();
    await recovery.stop();
    await close();
    await heartbeat.stop();
    await monitoring?.close();
    await closePostgres();
    logger.info('worker_stopped', { workerId: heartbeat.workerId });
    process.exit(0);
  } catch (err) {
    logger.error('worker_shutdown_failed', { err });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { err: reason });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { err });
  process.exit(1);
});

// Resolves once Redis is reachable (the connection keeps retrying until then).
await worker.waitUntilReady();
logger.info('worker_started', {
  env: config.env,
  pid: process.pid,
  workerId: heartbeat.workerId,
  queue: config.queue.name,
  concurrency: config.concurrency,
});

// Deployments need git and a reachable Docker daemon. Report problems at
// startup instead of on the first job (jobs would fail and be retried).
for (const [command, args] of [
  ['git', ['--version']],
  ['docker', ['version', '--format', 'Docker server {{.Server.Version}}']],
]) {
  try {
    const { code, tail } = await runCommand(command, args, { timeoutMs: 15000 });
    if (code === 0) logger.info('tool_available', { command, version: tail.at(-1) });
    else logger.warn('tool_unusable', { command, msg: tail.at(-1) });
  } catch (err) {
    logger.warn('tool_unusable', { command, err });
  }
}

// Optional integrations (names only, never keys).
const { aws, github } = config;
logger.info('integrations', {
  aws:
    aws.region && aws.ecrRepository && aws.ecsCluster
      ? { region: aws.region, ecrRepository: aws.ecrRepository, ecsCluster: aws.ecsCluster }
      : 'not configured (AWS_REGION, AWS_ECR_REPOSITORY, AWS_ECS_CLUSTER)',
  githubApp: github.appId && github.privateKey ? { appId: github.appId } : 'not configured: public repositories only',
});

// Deployments whose job was lost are ended, now and every RECOVERY_INTERVAL_MS.
recovery.start();

const swept = await sweepStaleWorkspaces().catch(() => 0);
logger.info('workspaces', { root: config.workspace.root, removedStale: swept });
