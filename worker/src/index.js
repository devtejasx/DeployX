// DeployX worker entry point: consumes jobs from the "deployments" queue.
import config from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { createDeploymentWorker } from './worker.js';

const { worker, close } = createDeploymentWorker();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`DeployX Worker received ${signal}, finishing running jobs before exit`);

  await close();
  await closePostgres();
  console.log('DeployX Worker stopped');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Resolves once Redis is reachable (the connection keeps retrying until then).
await worker.waitUntilReady();
console.log(
  `DeployX Worker started (${config.env}, pid ${process.pid}) - queue "${config.queue.name}", ` +
    `concurrency ${config.concurrency}`,
);
