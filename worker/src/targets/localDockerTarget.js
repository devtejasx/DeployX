import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import * as dockerService from '../services/dockerService.js';
import { containerName, deploymentLabels, firstPublishedHostPort, publishedHostPort } from '../services/dockerService.js';
import {
  recordContainer,
  recordContainerRemoved,
  unfinishedDeploymentIds,
} from '../services/deploymentService.js';
import { logger } from '../lib/logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deployment target LOCAL: the app runs as a container on the worker's Docker
// host (Phases 4-6).
//
// A deployment target is where a built image runs. The pipeline, the health
// check, promotion and rollback (pipeline/, rollbackService.js) are the same
// for every target and call these steps:
//
//   validate(project)                      before anything is built
//   publish(ctx, built)          BUILDING   make the image available to the target
//   deploy(ctx, artifact)        DEPLOYING  start the new version -> `deployed`
//   healthCheck(deployed)                   where the health check is sent
//   logs(deployed, lines)                   output of an unhealthy version
//   retirePrevious(ctx, deployed)           after SUCCESS: the old version stops
//   discardUnhealthy(ctx, deployed, { restoring })   take the unhealthy version down
//   restoreStable(ctx, stable)              rollback: run the stable version again
//   abandonRestored(restored)               ... which turned out unhealthy too
//   recordRestored(ctx, stable, restored)   ... which is healthy
//
// `docker` is the Docker service (replaced by a fake in tests).
export function createLocalDockerTarget({ docker = dockerService } = {}) {
  // The project's containers other than `keepContainerId`, except those of
  // deployments that are still being processed (they belong to their own jobs).
  async function retireContainers(ctx, keepContainerId) {
    const { deployment, project } = ctx;
    try {
      const others = (await docker.listProjectContainers(project.id)).filter(({ id }) => id !== keepContainerId);
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
      logger.error('previous_container_removal_failed', { projectId: project.id, deploymentId: deployment.id, err });
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

  return {
    name: 'LOCAL',
    // Deployments of one project run side by side; only promotion and
    // rollback are serialized (pipeline/release.js).
    serializeDeploys: false,
    retireContainers,

    validate(project) {
      if (!project.container_port) {
        throw new UnrecoverableError('Project has no container_port configured; set it with PUT /api/projects/:id');
      }
    },

    // The image built on the Docker host is what runs.
    async publish(ctx, built) {
      return { image: built.image };
    },

    // docker run -> verify running. Returns { containerId, name, hostPort, image }.
    async deploy(ctx, { image }) {
      const { deployment, project } = ctx;
      await docker.ensureAppNetwork();

      const name = containerName(project.id, deployment.id);
      // A container of an earlier attempt of this same deployment.
      if (await docker.inspectContainer(name)) {
        await docker.removeContainer(name);
        await ctx.log('INFO', `Removed container ${name} left by an earlier attempt`);
      }

      const labels = deploymentLabels({ projectId: project.id, deploymentId: deployment.id });
      await ctx.log('INFO', `Starting container ${name}`);
      const containerId = await docker.runContainer({ image, name, containerPort: project.container_port, labels });

      // Not the health check yet: only make sure it did not exit at once.
      await sleep(config.docker.startupGraceMs);
      const state = await docker.inspectContainer(containerId);
      if (!state?.State?.Running) {
        const exitCode = state?.State?.ExitCode;
        const output = await docker.containerLogs(containerId).catch(() => []);
        for (const line of output) await ctx.log('ERROR', `[container] ${line.slice(0, 1000)}`);
        await docker.removeContainer(containerId).catch(() => {});
        await ctx.log('INFO', `Removed failed container ${name}`);
        throw new Error(`Container exited immediately (exit code ${exitCode ?? 'unknown'})`);
      }

      const hostPort = publishedHostPort(state, project.container_port);
      await recordContainer(deployment.id, { containerId, containerName: name, hostPort });
      await ctx.log(
        'INFO',
        `Container started: ${name} (${containerId.slice(0, 12)}); port ${project.container_port} published on ` +
          `127.0.0.1:${hostPort}`,
      );
      return { containerId, name, hostPort, image };
    },

    // The container's published port on HEALTH_CHECK_HOST.
    healthCheck(deployed) {
      return {
        url: `http://${config.healthCheck.host}:${deployed.hostPort}`,
        options: { port: deployed.hostPort },
      };
    },

    logs(deployed, lines) {
      return docker.containerLogs(deployed.containerId, lines);
    },

    // One live deployment per project: this one is healthy and recorded as
    // SUCCESS, so the project's other containers are removed.
    async retirePrevious(ctx, deployed) {
      await retireContainers(ctx, deployed.containerId);
    },

    async discardUnhealthy(ctx, deployed) {
      await ctx.log('INFO', `Stopping unhealthy container ${deployed.name}`);
      try {
        await docker.removeContainer(deployed.containerId);
        await recordContainerRemoved(ctx.deployment.id, 'Container removed: the deployment failed its health check');
      } catch (err) {
        // Not fatal: the stable version can run next to it.
        await ctx.log('WARN', `Could not remove the unhealthy container: ${err.message}`);
      }
    },

    // The stable container if it still runs, otherwise a new one from its
    // image. Returns { containerId, name, hostPort, started }.
    async restoreStable(ctx, stable) {
      const restored = (await runningStableContainer(stable)) ?? (await startStableContainer(ctx, stable));
      if (!restored.started) await ctx.log('INFO', `Stable container ${restored.name} is still running`);
      return restored;
    },

    // A container that was already running is left alone; one started just
    // now for the rollback is removed again.
    async abandonRestored(restored) {
      if (restored.started) await docker.removeContainer(restored.containerId).catch(() => {});
    },

    // The stable deployment's record keeps its history; only the container it
    // now runs in is tracked.
    async recordRestored(ctx, stable, restored) {
      if (restored.started) {
        await recordContainer(stable.id, {
          containerId: restored.containerId,
          containerName: restored.name,
          hostPort: restored.hostPort,
        });
      }
    },
  };
}
