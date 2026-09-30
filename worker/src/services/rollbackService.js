import config from '../config/index.js';
import * as dockerService from './dockerService.js';
import { containerName, deploymentLabels, firstPublishedHostPort, publishedHostPort } from './dockerService.js';
import {
  addLog,
  findStableDeployment,
  markFailed,
  recordContainer,
  recordContainerRemoved,
  recordRollback,
} from './deploymentService.js';
import { waitForHealthy } from './healthCheckService.js';

export const NO_STABLE_DEPLOYMENT = 'No previous stable deployment available for rollback.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Automatic rollback of a deployment that failed its health check:
//   find the project's last stable deployment -> remove the unhealthy
//   container -> make sure the stable version runs (its container is normally
//   still running; otherwise it is started again from its image) -> health
//   check it -> record the outcome -> the failed deployment becomes FAILED, or
//   ROLLBACK_FAILED when the stable version could not be brought back.
//
// Safety rules:
// - only the project's own stable deployment is ever used (looked up by
//   project ID), and nothing is restored without its image and port
// - a rollback only counts as completed once the restored version passed its
//   health check; anything else is reported as a failed rollback
// - the stable deployment's record and the history are never rewritten: only
//   the container it currently runs in is tracked
// - the only containers removed are the failed deployment's own one and a
//   stopped leftover of the stable deployment
//
// `docker` is the Docker service (replaced by a fake in tests).
export function createRollbackService({ docker = dockerService } = {}) {
  async function removeUnhealthyContainer(ctx, container) {
    await ctx.log('INFO', `Stopping unhealthy container ${container.name}`);
    try {
      await docker.removeContainer(container.containerId);
      await recordContainerRemoved(ctx.deployment.id, 'Container removed: the deployment failed its health check');
    } catch (err) {
      // Not fatal: the stable version can run next to it.
      await ctx.log('WARN', `Could not remove the unhealthy container: ${err.message}`);
    }
  }

  // The stable deployment's container, if it is still running. That is the
  // normal case: a container is only retired after a newer deployment passed
  // its health check.
  async function runningStableContainer(stable) {
    if (!stable.container_id) return null;
    const inspection = await docker.inspectContainer(stable.container_id);
    if (!inspection?.State?.Running) return null;

    const hostPort = firstPublishedHostPort(inspection);
    if (!hostPort) throw new Error('the stable container has no published port');
    return { containerId: stable.container_id, name: stable.container_name, hostPort, started: false };
  }

  // Starts the stable version again from the image it was deployed with.
  async function startStableContainer(ctx, stable) {
    const { project } = ctx;
    // The image ID when it was recorded: unlike the tag, a later build of the
    // same commit cannot have moved it to another image.
    const image = stable.docker_image_id ?? stable.docker_image;
    if (!image) throw new Error('the stable deployment has no Docker image recorded');
    if (!project.container_port) throw new Error('the project has no container_port configured');
    if (!(await docker.imageExists(image))) {
      throw new Error(`image ${stable.docker_image} of the stable deployment is no longer available`);
    }

    const name = containerName(project.id, stable.id);
    // A stopped container of this same deployment would block the name.
    if (await docker.inspectContainer(name)) {
      await docker.removeContainer(name);
      await ctx.log('INFO', `Removed stopped container ${name}`);
    }

    const imageId = stable.docker_image_id ? ` (ID ${stable.docker_image_id.slice('sha256:'.length, 19)})` : '';
    await ctx.log('INFO', `Starting stable version from image ${stable.docker_image}${imageId}`);
    await docker.ensureAppNetwork();
    const containerId = await docker.runContainer({
      image,
      name,
      containerPort: project.container_port,
      labels: deploymentLabels({ projectId: project.id, deploymentId: stable.id }),
    });

    await sleep(config.docker.startupGraceMs);
    const state = await docker.inspectContainer(containerId);
    if (!state?.State?.Running) {
      await docker.removeContainer(containerId).catch(() => {});
      throw new Error(`the stable container exited immediately (exit code ${state?.State?.ExitCode ?? 'unknown'})`);
    }
    return { containerId, name, hostPort: publishedHostPort(state, project.container_port), started: true };
  }

  // Makes the stable deployment the live, verified version again. Throws with
  // the reason if that is not possible.
  async function restoreStable(ctx, stable) {
    const container = (await runningStableContainer(stable)) ?? (await startStableContainer(ctx, stable));
    if (!container.started) await ctx.log('INFO', `Stable container ${container.name} is still running`);

    await ctx.log('INFO', 'Running health check on the stable version');
    const result = await waitForHealthy({
      port: container.hostPort,
      path: ctx.project.health_check_path,
      // A container that was already serving needs no time to start.
      startupGracePeriod: container.started ? undefined : 0,
      onLog: ctx.log,
    });
    if (!result.healthy) {
      // A container that was already running is left alone; one started just
      // now for the rollback is removed again.
      if (container.started) await docker.removeContainer(container.containerId).catch(() => {});
      throw new Error(`the stable deployment is unhealthy too (${result.error})`);
    }
    await ctx.log('INFO', 'Stable version is healthy');

    if (container.started) {
      await recordContainer(stable.id, {
        containerId: container.containerId,
        containerName: container.name,
        hostPort: container.hostPort,
      });
    }
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
  // its running `container` { containerId, name }. The caller holds the
  // project lock. The deployment always ends in a final status (FAILED, or
  // ROLLBACK_FAILED when the rollback itself failed); returns
  // { status: 'COMPLETED' | 'FAILED' | 'NOT_AVAILABLE', stableDeploymentId, errorMessage }.
  return async function rollbackDeployment(ctx, { container, reason }) {
    const stable = await findStableDeployment(ctx.project.id);

    if (!stable) {
      // E.g. the project's first deployment: there is nothing to restore.
      await ctx.log('WARN', NO_STABLE_DEPLOYMENT);
      await removeUnhealthyContainer(ctx, container);
      return finish(ctx, {
        status: 'NOT_AVAILABLE',
        errorMessage: `${reason}. ${NO_STABLE_DEPLOYMENT}`,
        message: 'Deployment failed: the application is unhealthy and there is nothing to roll back to',
      });
    }

    await ctx.setStage('ROLLING_BACK', 'Starting automatic rollback');
    const commit = stable.commit_sha ? ` (commit ${stable.commit_sha.slice(0, 7)})` : '';
    await ctx.log('INFO', `Previous stable deployment: ${stable.id}${commit}`);
    await removeUnhealthyContainer(ctx, container);

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
