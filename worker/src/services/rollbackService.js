import { createLocalDockerTarget } from '../targets/localDockerTarget.js';
import * as dockerService from './dockerService.js';
import { addLog, findStableDeployment, markFailed, recordRollback } from './deploymentService.js';
import { waitForHealthy } from './healthCheckService.js';

export const NO_STABLE_DEPLOYMENT = 'No previous stable deployment available for rollback.';

// Automatic rollback of a deployment that failed its health check:
//   find the project's last stable deployment -> take the unhealthy version
//   down -> make sure the stable version runs (LOCAL: its container normally
//   still runs, otherwise it is started again from its image; AWS_ECS: its
//   image digest is deployed to the service again) -> health check it ->
//   record the outcome -> the failed deployment becomes FAILED, or
//   ROLLBACK_FAILED when the stable version could not be brought back.
//
// This is the only rollback there is: the deployment target (targets/)
// supplies the infrastructure steps, the flow and its rules are the same.
//
// Safety rules:
// - only the project's own stable deployment is ever used (looked up by
//   project ID), on the target the failed deployment ran on, and nothing is
//   restored without its image
// - a rollback only counts as completed once the restored version passed its
//   health check; anything else is reported as a failed rollback
// - the stable deployment's record and the history are never rewritten: only
//   where it currently runs (its container or task definition) is tracked
// - nothing is rebuilt: the stable version runs from the image it was built as
//
// `target` is the deployment target (by default LOCAL on `docker`, the Docker
// service, which tests replace by a fake).
export function createRollbackService({ docker = dockerService, target = createLocalDockerTarget({ docker }) } = {}) {
  // Makes the stable deployment the live, verified version again. Throws with
  // the reason if that is not possible.
  async function restoreStable(ctx, stable) {
    const restored = await target.restoreStable(ctx, stable);

    await ctx.log('INFO', 'Running health check on the stable version');
    const result = await waitForHealthy({
      ...target.healthCheck(restored).options,
      path: ctx.project.health_check_path,
      // A version that was already serving needs no time to start.
      startupGracePeriod: restored.started ? undefined : 0,
      onLog: ctx.log,
    });
    if (!result.healthy) {
      await target.abandonRestored(restored);
      throw new Error(`the stable deployment is unhealthy too (${result.error})`);
    }
    await ctx.log('INFO', 'Stable version is healthy');

    await target.recordRestored(ctx, stable, restored);
    await addLog(stable.id, 'INFO', `Restored as the live version: deployment ${ctx.deployment.id} failed its health check`);
  }

  // Stores the rollback outcome, then moves the deployment to its final status
  // with its last log line (in that order, so the final status already carries
  // the outcome): ROLLBACK_FAILED after a failed rollback, FAILED otherwise.
  async function finish(ctx, { status, stable = null, errorMessage, message }) {
    await recordRollback(ctx.deployment.id, { status, rollbackDeploymentId: stable?.id ?? null });
    await markFailed(ctx.deployment.id, errorMessage, message, {
      status: status === 'FAILED' ? 'ROLLBACK_FAILED' : 'FAILED',
    });
    return { status, stableDeploymentId: stable?.id ?? null, errorMessage };
  }

  // Handles `ctx.deployment` having failed its health check (`reason`), with
  // `deployed` the version the target started for it. The caller holds the
  // project lock. The deployment always ends in a final status (FAILED, or
  // ROLLBACK_FAILED when the rollback itself failed); returns
  // { status: 'COMPLETED' | 'FAILED' | 'NOT_AVAILABLE', stableDeploymentId, errorMessage }.
  return async function rollbackDeployment(ctx, { deployed, reason }) {
    const found = await findStableDeployment(ctx.project.id);
    // A stable version that ran on another target (the project was switched
    // between LOCAL and AWS_ECS) cannot be restored here.
    const stable = found?.deployment_target === ctx.deployment.deployment_target ? found : null;

    if (!stable) {
      // E.g. the project's first deployment: there is nothing to restore.
      const note = found
        ? `No previous stable deployment on ${ctx.deployment.deployment_target} available for rollback ` +
          `(the last stable deployment ran on ${found.deployment_target}).`
        : NO_STABLE_DEPLOYMENT;
      await ctx.log('WARN', note);
      await target.discardUnhealthy(ctx, deployed, { restoring: false });
      return finish(ctx, {
        status: 'NOT_AVAILABLE',
        errorMessage: `${reason}. ${note}`,
        message: 'Deployment failed: the application is unhealthy and there is nothing to roll back to',
      });
    }

    await ctx.setStage('ROLLING_BACK', 'Starting automatic rollback');
    const commit = stable.commit_sha ? ` (commit ${stable.commit_sha.slice(0, 7)})` : '';
    await ctx.log('INFO', `Previous stable deployment: ${stable.id}${commit}`);
    await target.discardUnhealthy(ctx, deployed, { restoring: true });

    try {
      await restoreStable(ctx, stable);
    } catch (err) {
      await ctx.log('ERROR', `Rollback failed: ${err.message}`);
      return finish(ctx, {
        status: 'FAILED',
        stable,
        errorMessage: `${reason}. Rollback to deployment ${stable.id} failed: ${err.message}`,
        message: 'Deployment failed: the application is unhealthy and the rollback failed',
      });
    }

    await ctx.log('INFO', `Rollback completed successfully: deployment ${stable.id} is live`);
    return finish(ctx, {
      status: 'COMPLETED',
      stable,
      errorMessage: `${reason}. Rolled back to deployment ${stable.id}.`,
      message: 'Deployment failed: the application is unhealthy; the last stable version was restored',
    });
  };
}
