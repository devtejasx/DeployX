import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { RecordedFailureError } from '../lib/errors.js';
import { runWithJobContext } from '../lib/jobContext.js';
import { deploymentTimeouts } from '../lib/metrics.js';
import { runDockerDeployment } from '../pipeline/dockerDeployment.js';
import {
  TERMINAL_STATUSES,
  addLog,
  getDeploymentWithProject,
  markFailed,
  recordRollback,
  transitionDeploymentStatus,
} from '../services/deploymentService.js';
import { logger } from '../lib/logger.js';

// Statuses only a running attempt leaves behind. A job that starts and finds
// its deployment in one of them is picking up after an interrupted attempt.
const INTERRUPTED_STATUSES = ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK'];

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
// How long a timed-out pipeline gets to stop and clean up (its running command
// is killed at once; cleanup commands have their own limits) before the job
// gives up waiting for it.
const TIMEOUT_GRACE_MS = 2 * 60 * 1000;

// 400 -> "0.4s", 90000 -> "1.5 minutes".
function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 100) / 10}s`;
  const minutes = Math.round((ms / 60000) * 10) / 10;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function createDeploymentProcessor({
  pipeline = runDockerDeployment,
  timeoutMs = config.deploymentTimeoutMs,
  timeoutGraceMs = TIMEOUT_GRACE_MS,
} = {}) {
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
    if (deployment.status === 'ROLLING_BACK') {
      // Only possible when a worker died in the middle of a rollback and
      // BullMQ hands the job out again. A rollback is not resumed or redone:
      // the deployment failed, and its rollback did not complete.
      await recordRollback(deploymentId, { status: 'FAILED', rollbackDeploymentId: deployment.rollback_deployment_id });
      await markFailed(
        deploymentId,
        'The worker stopped during the rollback; the rollback did not complete',
        'Deployment failed: the rollback was interrupted',
        { status: 'ROLLBACK_FAILED' },
      );
      return { skipped: true, reason: 'Rollback was interrupted' };
    }
    if (INTERRUPTED_STATUSES.includes(deployment.status)) {
      // The previous attempt ended without recording how: the worker was
      // killed, or PostgreSQL was unreachable when the attempt failed. The
      // deployment goes back to QUEUED, as after any failed attempt, and
      // this attempt starts from the beginning.
      await transitionDeploymentStatus(deploymentId, 'QUEUED', {
        message: `Previous attempt was interrupted during ${deployment.status}; starting again`,
        level: 'WARN',
      });
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

    // DEPLOYMENT_TIMEOUT_MS: the whole attempt, whatever it is doing.
    const controller = new AbortController();
    const timeoutMessage = `Deployment timed out after ${formatDuration(timeoutMs)}`;
    let graceTimer;
    const timer = setTimeout(() => {
      controller.abort();
      deploymentTimeouts.inc();
      logger.warn('deployment_timeout', { deploymentId, jobId: job.id, timeoutMs });
      addLog(deploymentId, 'ERROR', `${timeoutMessage} (DEPLOYMENT_TIMEOUT_MS); stopping it`).catch(() => {});
    }, timeoutMs);
    // If the pipeline does not wind down after the abort, the job ends anyway.
    const abandoned = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        graceTimer = setTimeout(() => reject(new Error(`${timeoutMessage}; it did not stop within ${formatDuration(timeoutGraceMs)}`)), timeoutGraceMs);
      });
    });

    try {
      await addLog(deploymentId, 'INFO', `Deployment job started (attempt ${attempt} of ${maxAttempts})`);
      const running = runWithJobContext({ signal: controller.signal }, () => pipeline(context));
      running.catch(() => {}); // settled below, or abandoned after the grace period
      return await Promise.race([running, abandoned]);
    } catch (caught) {
      let err = caught;
      // A timed-out attempt is final: another one would time out the same way.
      if (controller.signal.aborted && !(err instanceof RecordedFailureError)) {
        const message = caught.message.startsWith(timeoutMessage) ? caught.message : `${timeoutMessage}: ${caught.message}`;
        err = new UnrecoverableError(message);
      }
      // An unhealthy deployment: the pipeline already recorded the failure
      // and the rollback. The job just ends as failed, without a retry.
      if (err instanceof RecordedFailureError) throw err;

      // Record what happened, then rethrow so BullMQ applies its retry policy.
      // Bookkeeping errors must not replace the original error.
      try {
        await recordFailedAttempt(job, err, attempt, maxAttempts);
      } catch (bookkeepingError) {
        logger.error('failure_bookkeeping_failed', { jobId: job.id, deploymentId, err: bookkeepingError });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      clearTimeout(graceTimer);
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
