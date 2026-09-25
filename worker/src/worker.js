import { Worker } from 'bullmq';
import config from './config/index.js';
import { createRedisConnection } from './config/redis.js';
import { createDeploymentProcessor } from './processors/deploymentProcessor.js';

// Creates a BullMQ worker on the deployments queue. Up to `concurrency` jobs
// run at the same time; the rest wait in Redis until a slot frees up.
export function createDeploymentWorker({
  concurrency = config.concurrency,
  processor = createDeploymentProcessor(),
} = {}) {
  const connection = createRedisConnection();

  const worker = new Worker(config.queue.name, processor, {
    connection,
    prefix: config.queue.prefix,
    concurrency,
  });

  worker.on('active', (job) => {
    console.log(`[worker] job ${job.id} started (attempt ${job.attemptsMade + 1} of ${job.opts.attempts ?? 1})`);
  });

  worker.on('completed', (job, result) => {
    const outcome = result?.skipped ? `skipped: ${result.reason}` : 'completed';
    console.log(`[worker] job ${job.id} ${outcome}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed: ${err.message}`);
  });

  // Connection problems and similar; BullMQ keeps retrying on its own.
  worker.on('error', (err) => {
    console.error('[worker] error:', err.message || err);
  });

  // Stops taking new jobs, waits for the running ones (unless `force`), then
  // closes the Redis connection.
  async function close(force = false) {
    await worker.close(force);
    await connection.quit().catch(() => connection.disconnect());
  }

  return { worker, close };
}
