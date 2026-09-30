import config from '../config/index.js';
import { withProjectLock } from '../db/postgres.js';
import { RecordedFailureError } from '../lib/errors.js';
import * as dockerService from '../services/dockerService.js';
import { recordContainerRemoved, unfinishedDeploymentIds } from '../services/deploymentService.js';
import { waitForHealthy } from '../services/healthCheckService.js';
import { createRollbackService } from '../services/rollbackService.js';

// Lines of the unhealthy container's output copied into the deployment logs.
const CONTAINER_LOG_LINES = 20;

// The last stage of a deployment, once its container is running:
//
//   HEALTH_CHECK ── healthy ──> SUCCESS   (then the previous container is retired)
//        │
//        └── unhealthy ──> ROLLING_BACK ──> FAILED   (last stable version restored)
//                     └──> FAILED                    (no stable version to restore)
//
// A deployment is never SUCCESS because its container started: only a passed
// health check leads there. The previous stable container keeps running
// until then, so an unhealthy deployment never takes the project down.
//
// `docker` is the Docker service (replaced by a fake in tests).
export function createRelease({ docker = dockerService } = {}) {
  const rollbackDeployment = createRollbackService({ docker });

  // One live deployment per project: this one is healthy and recorded as
  // SUCCESS, so the project's other containers are removed. Containers of
  // deployments that are still being processed belong to their own jobs.
  async function retirePreviousContainers(ctx, container) {
    const { deployment, project } = ctx;
    try {
      const others = (await docker.listProjectContainers(project.id)).filter(({ id }) => id !== container.containerId);
      const unfinished = await unfinishedDeploymentIds(others.map((other) => other.deploymentId));
      for (const previous of others) {
        if (unfinished.has(previous.deploymentId)) continue;
        await docker.removeContainer(previous.id);
        if (previous.deploymentId) {
          await recordContainerRemoved(previous.deploymentId, `Container removed: replaced by deployment ${deployment.id}`);
        }
      }
    } catch (err) {
      // The deployment itself succeeded. A container left behind is removed
      // by the project's next successful deployment.
      console.error(`[worker] could not remove previous containers of project ${project.id}: ${err.message}`);
    }
  }

  // `container`: { containerId, name, hostPort, image } of the deployment's
  // running container. Returns the job result on SUCCESS; throws
  // RecordedFailureError after an unhealthy deployment was handled.
  return async function release(ctx, container) {
    const { project } = ctx;
    const { host, retries, timeoutMs, intervalMs } = config.healthCheck;
    const path = project.health_check_path;

    await ctx.setStage(
      'HEALTH_CHECK',
      `Running health checks: GET http://${host}:${container.hostPort}${path} ` +
        `(up to ${retries} attempts, ${timeoutMs / 1000}s timeout, ${intervalMs / 1000}s apart)`,
    );
    const result = await waitForHealthy({ port: container.hostPort, path, onLog: ctx.log });

    if (result.healthy) {
      // Promotion and rollback of one project never run at the same time.
      return withProjectLock(project.id, async () => {
        await ctx.setStage('SUCCESS', 'Deployment completed successfully');
        await retirePreviousContainers(ctx, container);
        return {
          status: 'SUCCESS',
          image: container.image,
          containerId: container.containerId,
          hostPort: container.hostPort,
        };
      });
    }

    const reason = `Health check failed after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}: ${result.error}`;
    await ctx.log('ERROR', reason);
    const output = await docker.containerLogs(container.containerId, CONTAINER_LOG_LINES).catch(() => []);
    for (const line of output) await ctx.log('INFO', `[container] ${line.slice(0, 1000)}`);
    await ctx.log('ERROR', 'Deployment marked unhealthy');

    const outcome = await withProjectLock(project.id, () => rollbackDeployment(ctx, { container, reason }));
    // Rebuilding the same commit cannot make it healthy: no retry.
    throw new RecordedFailureError(outcome.errorMessage);
  };
}
