import { Worker } from 'bullmq';
import config from './config/index.js';
import { createRedisConnection } from './config/redis.js';
import { createDeploymentProcessor } from './processors/deploymentProcessor.js';
import { addLog, markFailed } from './services/deploymentService.js';

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

  worker.on('failed', async (job, err) => {
    console.error(`[worker] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
    if (!job) return;

    // Safety net for failures that happen outside the processor (e.g. a job
    // that stalled too often). The processor already marks normal final
    // failures; markFailed() is a no-op for deployments that are final.
    try {
      if ((await job.getState()) !== 'failed') return; // a retry is scheduled
      if (await markFailed(job.data.deploymentId)) {
        await addLog(job.data.deploymentId, 'ERROR', `Deployment failed: ${err.message}`);
      }
    } catch (handlerError) {
      console.error(`[worker] could not record final failure of job ${job.id}:`, handlerError.message);
    }
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
