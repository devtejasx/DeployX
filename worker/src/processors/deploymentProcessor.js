import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { TERMINAL_STATUSES, addLog, getDeployment, markFailed, setStatus } from '../services/deploymentService.js';
import { simulatedBuildFailure } from './simulatedFailures.js';

// ============================================================================
// SIMULATION - Phase 3 only.
//
// This processor stands in for the real deployment pipeline. It walks the
// deployment through QUEUED -> BUILDING -> DEPLOYING -> SUCCESS and waits
// between stages, but it does NOT clone repositories, build images or run
// containers. Phase 4 replaces the simulated stages with the real pipeline.
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Delay BullMQ will wait before the next attempt (for the log message only).
function nextRetryDelayMs(job, attempt) {
  const { backoff } = job.opts;
  if (!backoff) return 0;
  if (typeof backoff === 'number') return backoff;
  return backoff.type === 'exponential' ? backoff.delay * 2 ** (attempt - 1) : backoff.delay;
}

export function createDeploymentProcessor({ stepMs = config.simulation.stepMs } = {}) {
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
    const deployment = await getDeployment(deploymentId);
    if (!deployment) {
      return { skipped: true, reason: 'Deployment no longer exists' };
    }
    if (TERMINAL_STATUSES.includes(deployment.status)) {
      return { skipped: true, reason: `Deployment already finished with status ${deployment.status}` };
    }

    async function moveTo(status, message) {
      const updated = await setStatus(deploymentId, status);
      if (!updated) {
        // Deleted mid-flight (its project was removed): retrying cannot help.
        throw new UnrecoverableError('Deployment was deleted while it was being processed');
      }
      await addLog(deploymentId, 'INFO', message);
    }

    try {
      await addLog(deploymentId, 'INFO', `Deployment job started (attempt ${attempt} of ${maxAttempts})`);

      await moveTo('BUILDING', 'Deployment is now building');
      await sleep(stepMs); // SIMULATION: stands in for git clone + docker build
      const buildError = simulatedBuildFailure(deployment.branch, attempt, maxAttempts);
      if (buildError) throw buildError;
      await addLog(deploymentId, 'INFO', 'Build simulation completed (no image was built)');

      await moveTo('DEPLOYING', 'Deployment is now deploying');
      await sleep(stepMs); // SIMULATION: stands in for starting the container
      await addLog(deploymentId, 'INFO', 'Deployment simulation completed (no container was started)');

      await moveTo('SUCCESS', 'Deployment completed successfully');
      return { status: 'SUCCESS' };
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
  const willRetry = !(err instanceof UnrecoverableError) && attempt < maxAttempts;

  await addLog(deploymentId, 'ERROR', `Attempt ${attempt} of ${maxAttempts} failed: ${err.message}`);

  if (willRetry) {
    // Back to QUEUED while BullMQ waits to retry; started_at is kept.
    await setStatus(deploymentId, 'QUEUED');
    const delaySeconds = nextRetryDelayMs(job, attempt) / 1000;
    await addLog(deploymentId, 'WARN', `Retrying in ${delaySeconds}s (attempt ${attempt + 1} of ${maxAttempts})`);
    return;
  }

  const changed = await markFailed(deploymentId);
  if (changed) {
    const message =
      err instanceof UnrecoverableError
        ? 'Deployment failed and will not be retried'
        : 'Deployment failed after maximum retry attempts';
    await addLog(deploymentId, 'ERROR', message);
  }
}
