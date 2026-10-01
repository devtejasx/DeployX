import { Worker } from 'bullmq';
import config from './config/index.js';
import { createRedisConnection } from './config/redis.js';
import { clearEventPublisher, setEventPublisher } from './events/deploymentEvents.js';
import { logger } from './lib/logger.js';
import { jobsActive, jobsCompleted, jobsFailed } from './lib/metrics.js';
import { createDeploymentProcessor } from './processors/deploymentProcessor.js';
import { markFailed } from './services/deploymentService.js';

// Creates a BullMQ worker on the deployments queue. Up to `concurrency` jobs
// run at the same time; the rest wait in Redis until a slot frees up.
export function createDeploymentWorker({
  concurrency = config.concurrency,
  processor = createDeploymentProcessor(),
} = {}) {
  const connection = createRedisConnection();
  // Real-time log/status events are published on this same connection.
  setEventPublisher(connection);

  const worker = new Worker(config.queue.name, processor, {
    connection,
    prefix: config.queue.prefix,
    concurrency,
  });

  // Jobs this worker runs right now (heartbeat, metrics).
  const active = new Set();
  const jobFields = (job) => ({ jobId: job?.id, deploymentId: job?.data?.deploymentId, projectId: job?.data?.projectId });

  worker.on('active', (job) => {
    active.add(job.id);
    jobsActive.set(active.size);
    logger.info('job_started', { ...jobFields(job), attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 });
  });

  worker.on('completed', (job, result) => {
    active.delete(job.id);
    jobsActive.set(active.size);
    jobsCompleted.inc();
    const durationMs = job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    logger.info('job_completed', {
      ...jobFields(job),
      status: result?.status ?? (result?.skipped ? 'skipped' : 'completed'),
      reason: result?.skipped ? result.reason : undefined,
      durationMs,
    });
  });

  worker.on('failed', async (job, err) => {
    if (job) active.delete(job.id);
    jobsActive.set(active.size);
    if (!job) {
      jobsFailed.inc({ final: 'unknown' });
      logger.error('job_failed', { err });
      return;
    }

    // Safety net for failures that happen outside the processor (e.g. a job
    // that stalled too often). The processor already marks normal final
    // failures; markFailed() is a no-op for deployments that are final.
    try {
      const final = (await job.getState()) === 'failed';
      jobsFailed.inc({ final: String(final) });
      logger.warn('job_failed', { ...jobFields(job), attempt: job.attemptsMade, final, err });
      if (!final) return; // a retry is scheduled
      await markFailed(job.data.deploymentId, err.message, `Deployment failed: ${err.message}`);
    } catch (handlerError) {
      logger.error('final_failure_bookkeeping_failed', { ...jobFields(job), err: handlerError });
    }
  });

  worker.on('stalled', (jobId) => {
    logger.warn('job_stalled', { jobId, msg: 'A worker stopped while running this job; it is handed out again' });
  });

  // Connection problems and similar; BullMQ keeps retrying on its own.
  worker.on('error', (err) => {
    logger.error('worker_error', { err });
  });

  // Stops taking new jobs, waits for the running ones (unless `force`), then
  // closes the Redis connection.
  async function close(force = false) {
    await worker.close(force);
    clearEventPublisher(connection);
    await connection.quit().catch(() => connection.disconnect());
  }

  return { worker, connection, close, activeJobs: () => active.size };
}
