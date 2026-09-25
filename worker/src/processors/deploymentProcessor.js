import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { TERMINAL_STATUSES, addLog, getDeployment, setStatus } from '../services/deploymentService.js';

// ============================================================================
// SIMULATION - Phase 3 only.
//
// This processor stands in for the real deployment pipeline. It walks the
// deployment through QUEUED -> BUILDING -> DEPLOYING -> SUCCESS and waits
// between stages, but it does NOT clone repositories, build images or run
// containers. Phase 4 replaces the simulated stages with the real pipeline.
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    await addLog(deploymentId, 'INFO', `Deployment job started (attempt ${attempt} of ${maxAttempts})`);

    await moveTo('BUILDING', 'Deployment is now building');
    await sleep(stepMs); // SIMULATION: stands in for git clone + docker build
    await addLog(deploymentId, 'INFO', 'Build simulation completed (no image was built)');

    await moveTo('DEPLOYING', 'Deployment is now deploying');
    await sleep(stepMs); // SIMULATION: stands in for starting the container
    await addLog(deploymentId, 'INFO', 'Deployment simulation completed (no container was started)');

    await moveTo('SUCCESS', 'Deployment completed successfully');
    return { status: 'SUCCESS' };
  };
}
