import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { runDockerDeployment } from '../pipeline/dockerDeployment.js';
import {
  TERMINAL_STATUSES,
  addLog,
  getDeploymentWithProject,
  markFailed,
  transitionDeploymentStatus,
} from '../services/deploymentService.js';

// Delay BullMQ will wait before the next attempt (for the log message only).
function nextRetryDelayMs(job, attempt) {
  const { backoff } = job.opts;
  if (!backoff) return 0;
  if (typeof backoff === 'number') return backoff;
  return backoff.type === 'exponential' ? backoff.delay * 2 ** (attempt - 1) : backoff.delay;
}

// Wraps a deployment pipeline with everything that is the same for every
// job: loading the deployment, idempotency, attempt logging and failure
// bookkeeping for BullMQ's retries. The pipeline itself does the work
// (pipeline/dockerDeployment.js); tests can pass a fake one.
export function createDeploymentProcessor({ pipeline = runDockerDeployment } = {}) {
  return async function processDeployment(job) {
    if (job.name !== config.queue.jobName) {
      throw new UnrecoverableError(`Unknown job type "${job.name}"`);
    }

    const { deploymentId } = job.data;
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    // Idempotency: the job ID is the deployment ID, so BullMQ never holds two
    // jobs for one deployment at once. If a job is re-added after the first
    // one was cleaned up, the deployment is already final and nothing is redone.
    const deployment = await getDeploymentWithProject(deploymentId);
    if (!deployment) {
      return { skipped: true, reason: 'Deployment no longer exists' };
    }
    if (TERMINAL_STATUSES.includes(deployment.status)) {
      return { skipped: true, reason: `Deployment already finished with status ${deployment.status}` };
    }

    const context = {
      job,
      attempt,
      maxAttempts,
      deployment,
      project: deployment.project,
      log: (level, message) => addLog(deploymentId, level, message),
      // Moves the deployment to a new status (through the state machine)
      // together with its log line.
      async setStage(status, message) {
        const updated = await transitionDeploymentStatus(deploymentId, status, { message });
        if (!updated) {
          // Deleted mid-flight (its project was removed): retrying cannot help.
          throw new UnrecoverableError('Deployment was deleted while it was being processed');
        }
        return updated;
      },
    };

    try {
      await addLog(deploymentId, 'INFO', `Deployment job started (attempt ${attempt} of ${maxAttempts})`);
      return await pipeline(context);
    } catch (err) {
      // Record what happened, then rethrow so BullMQ applies its retry policy.
      // Bookkeeping errors must not replace the original error.
      try {
        await recordFailedAttempt(job, err, attempt, maxAttempts);
      } catch (bookkeepingError) {
        console.error(`[worker] could not record failure of job ${job.id}:`, bookkeepingError.message);
      }
      throw err;
    }
  };
}

async function recordFailedAttempt(job, err, attempt, maxAttempts) {
  const { deploymentId } = job.data;
  const unrecoverable = err instanceof UnrecoverableError;
  const willRetry = !unrecoverable && attempt < maxAttempts;

  await addLog(deploymentId, 'ERROR', `Attempt ${attempt} of ${maxAttempts} failed: ${err.message}`);

  if (willRetry) {
    // Back to QUEUED while BullMQ waits to retry; started_at is kept.
    const delaySeconds = nextRetryDelayMs(job, attempt) / 1000;
    await transitionDeploymentStatus(deploymentId, 'QUEUED', {
      message: `Retrying in ${delaySeconds}s (attempt ${attempt + 1} of ${maxAttempts})`,
      level: 'WARN',
    });
    return;
  }

  await markFailed(
    deploymentId,
    err.message,
    unrecoverable ? 'Deployment failed and will not be retried' : 'Deployment failed after maximum retry attempts',
  );
}
