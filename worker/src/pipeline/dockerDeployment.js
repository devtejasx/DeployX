import { UnrecoverableError } from 'bullmq';
import { withProjectLock } from '../db/postgres.js';
import { createTargets } from '../targets/index.js';
import { createSourceBuild } from './build.js';
import { createRelease } from './release.js';

const withoutLock = (projectId, fn) => fn();

// The deployment pipeline. There is exactly one, whatever created the
// deployment (the API or a GitHub push) and wherever it runs:
//
//   BUILDING:     git clone -> checkout commit -> Dockerfile check -> docker build   (build.js)
//                 -> publish (AWS_ECS: push to ECR)
//   DEPLOYING:    start the new version (LOCAL: docker run; AWS_ECS: ECS rollout)
//   HEALTH_CHECK: HTTP health check with retries                               (release.js)
//   SUCCESS, or ROLLING_BACK -> FAILED / ROLLBACK_FAILED when the application is unhealthy
//
// Where the new version runs is the deployment's target (deployments.
// deployment_target, see targets/). The workspace is removed once the new
// version runs, and at the end whatever happens.
//
// `build` and `targets` are replaced in tests.
export function createDeploymentPipeline({ build = createSourceBuild(), targets = createTargets() } = {}) {
  const releases = new Map();

  // One release stage per target. A target that runs its deployments one at a
  // time (AWS_ECS) already holds the project lock around deploy + release.
  function releaseFor(target) {
    if (!releases.has(target)) {
      releases.set(target, createRelease({ target, lock: target.serializeDeploys ? withoutLock : withProjectLock }));
    }
    return releases.get(target);
  }

  return async function runDeployment(ctx) {
    const { deployment, project } = ctx;
    const target = targets[deployment.deployment_target];
    if (!target) throw new UnrecoverableError(`Unknown deployment target "${deployment.deployment_target}"`);
    target.validate(project);

    await ctx.setStage('BUILDING', 'Deployment is now building');
    const built = await build(ctx);
    try {
      const artifact = await target.publish(ctx, built);

      const lock = target.serializeDeploys ? withProjectLock : withoutLock;
      return await lock(project.id, async () => {
        await ctx.setStage('DEPLOYING', 'Deployment is now deploying');
        const deployed = await target.deploy(ctx, artifact);

        // The sources are no longer needed; the new version runs from its image.
        await built.cleanUp();

        // A running version is not a successful deployment yet: the health
        // check decides, and an unhealthy deployment is rolled back.
        return await releaseFor(target)(ctx, deployed);
      });
    } finally {
      await built.cleanUp();
    }
  };
}

// The pipeline the worker runs.
export const runDockerDeployment = createDeploymentPipeline();
