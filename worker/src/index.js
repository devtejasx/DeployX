// DeployX worker entry point: consumes jobs from the "deployments" queue.
import config from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { runCommand } from './lib/exec.js';
import { sweepStaleWorkspaces } from './services/workspace.js';
import { createDeploymentWorker } from './worker.js';

const { worker, close } = createDeploymentWorker();

let shuttingDown = false;

// Graceful shutdown: stop taking new jobs, let running jobs finish, then
// close Redis and PostgreSQL. If running jobs take longer than
// WORKER_SHUTDOWN_TIMEOUT_MS, exit anyway: their locks expire, BullMQ treats
// them as stalled and hands them to the next worker that starts.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`DeployX Worker received ${signal}, finishing running jobs before exit`);

  const forceExit = setTimeout(() => {
    console.error(
      `DeployX Worker: running jobs did not finish within ${config.shutdownTimeoutMs}ms, exiting anyway ` +
        '(they will be picked up again when a worker starts)',
    );
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await close();
    await closePostgres();
    console.log('DeployX Worker stopped');
    process.exit(0);
  } catch (err) {
    console.error('DeployX Worker: error during shutdown:', err.message || err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Resolves once Redis is reachable (the connection keeps retrying until then).
await worker.waitUntilReady();
console.log(
  `DeployX Worker started (${config.env}, pid ${process.pid}) - queue "${config.queue.name}", ` +
    `concurrency ${config.concurrency}`,
);

// Deployments need git and a reachable Docker daemon. Report problems at
// startup instead of on the first job (jobs would fail and be retried).
for (const [command, args] of [
  ['git', ['--version']],
  ['docker', ['version', '--format', 'Docker server {{.Server.Version}}']],
]) {
  try {
    const { code, tail } = await runCommand(command, args, { timeoutMs: 15000 });
    console.log(code === 0 ? `[worker] ${tail.at(-1)}` : `[worker] WARNING: ${command} is not usable: ${tail.at(-1)}`);
  } catch (err) {
    console.error(`[worker] WARNING: ${err.message}`);
  }
}

const swept = await sweepStaleWorkspaces().catch(() => 0);
if (swept > 0) console.log(`[worker] removed ${swept} stale deployment workspace(s)`);
console.log(`[worker] deployment workspaces in ${config.workspace.root}`);
