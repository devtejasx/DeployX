import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { createAwsDeploymentService, taskDefinitionName } from '../services/awsDeploymentService.js';
import { recordRegistryImage, recordTaskDefinition } from '../services/deploymentService.js';
import * as dockerService from '../services/dockerService.js';
import { projectImageName } from '../services/dockerService.js';
import { createEcrService } from '../services/ecrService.js';
import { serviceHealthCheckUrl } from '../services/healthCheckService.js';

// Deployment target AWS_ECS: the image built by the worker is pushed to Amazon
// ECR and runs on the project's Amazon ECS service (Fargate or EC2).
//
//   BUILDING   docker build (as for LOCAL) -> ECR login -> tag + push -> digest
//   DEPLOYING  new task definition revision with <repository>@<digest>
//              -> UpdateService -> wait for the rollout
//   then the same health check, promotion and rollback as every target, on
//   the project's service URL
//
// The steps are described in localDockerTarget.js. The ECS service is the
// project's one live slot, so deployments of one project to AWS run one at a
// time (serializeDeploys), and a rollback deploys the stable deployment's
// image digest to it again - no rebuild.
//
// `ecr` and `ecs` are the ECR and ECS services (fakes in tests), `local` the
// LOCAL target, whose containers of the project are retired once the project
// runs on AWS.
export function createAwsEcsTarget({ ecr, ecs, docker = dockerService, local } = {}) {
  const ecrService = () => (ecr ??= createEcrService({ docker }));
  const ecsService = () => (ecs ??= createAwsDeploymentService());

  function missingSettings() {
    return [
      ['AWS_REGION', config.aws.region],
      ['AWS_ECR_REPOSITORY', config.aws.ecrRepository],
      ['AWS_ECS_CLUSTER', config.aws.ecsCluster],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
  }

  // ECR tags: <project>-<project-id-prefix>-<commit-12> and ...-deployment-<id>.
  function registryTags(project, commitSha, deploymentId) {
    const name = projectImageName(project.name, project.id);
    return [`${name}-${commitSha.slice(0, 12)}`, `${name}-deployment-${deploymentId}`];
  }

  // Deploys `image` to the project's service; on a failed or timed-out rollout
  // the service is pointed back at what it ran before, so the failed revision
  // does not keep trying to start (the old tasks never stopped).
  async function rollOut(ctx, image) {
    const { project } = ctx;
    try {
      return await ecsService().deployImage({
        service: project.aws_ecs_service,
        image,
        containerPort: project.container_port,
        onLog: ctx.log,
      });
    } catch (err) {
      if (err.previousTaskDefinitionArn) {
        await ctx.log(
          'WARN',
          `Reverting ECS service ${project.aws_ecs_service} to ${taskDefinitionName(err.previousTaskDefinitionArn)}`,
        );
        await ecsService()
          .pointServiceTo(project.aws_ecs_service, err.previousTaskDefinitionArn)
          .catch((revertError) => ctx.log('WARN', `Could not revert the ECS service: ${revertError.message}`));
      }
      throw err;
    }
  }

  return {
    name: 'AWS_ECS',
    serializeDeploys: true,

    validate(project) {
      const missing = missingSettings();
      if (missing.length > 0) {
        throw new UnrecoverableError(`AWS deployments are not configured on this worker: set ${missing.join(', ')}`);
      }
      if (!project.aws_ecs_service || !project.aws_service_url) {
        throw new UnrecoverableError(
          'Project has no AWS ECS service or service URL configured; set them with PUT /api/projects/:id',
        );
      }
      if (!project.container_port) {
        throw new UnrecoverableError('Project has no container_port configured; set it with PUT /api/projects/:id');
      }
      // Same rule as the API and the database; the health check re-checks it.
      try {
        serviceHealthCheckUrl({ baseUrl: project.aws_service_url, path: '/' });
      } catch (err) {
        throw new UnrecoverableError(`Invalid AWS service URL: ${err.message}`);
      }
    },

    async publish(ctx, built) {
      const { deployment, project } = ctx;
      await ctx.log('INFO', `Logging in to Amazon ECR (repository ${ecrService().repository})`);
      await ecrService().login();
      await ctx.log('INFO', 'ECR login succeeded');

      const tags = registryTags(project, built.commitSha, deployment.id);
      await ctx.log('INFO', `Pushing image to ECR as ${tags[0]}`);
      const { reference, digest } = await ecrService().push(built.image, tags);
      await recordRegistryImage(deployment.id, reference, digest);
      await ctx.log('INFO', `Image pushed to ECR: ${reference} (digest ${digest})`);

      const repositoryUri = reference.slice(0, reference.lastIndexOf(':'));
      return { image: `${repositoryUri}@${digest}`, reference, digest };
    },

    async deploy(ctx, artifact) {
      const { deployment, project } = ctx;
      await ctx.log(
        'INFO',
        `AWS deployment started: ECS service ${project.aws_ecs_service} in cluster ${ecsService().cluster}`,
      );
      const { taskDefinitionArn, previousTaskDefinitionArn } = await rollOut(ctx, artifact.image);
      await recordTaskDefinition(deployment.id, taskDefinitionArn);
      await ctx.log(
        'INFO',
        `AWS deployment completed: ECS service ${project.aws_ecs_service} runs ${taskDefinitionName(taskDefinitionArn)}`,
      );
      return {
        service: project.aws_ecs_service,
        url: project.aws_service_url,
        taskDefinitionArn,
        previousTaskDefinitionArn,
        image: artifact.image,
      };
    },

    healthCheck(deployed) {
      return { url: deployed.url, options: { baseUrl: deployed.url } };
    },

    // Task output lives in the service's log configuration (e.g. CloudWatch
    // Logs), which DeployX does not read.
    async logs() {
      return [];
    },

    // The project now runs on AWS: containers of earlier LOCAL deployments stop.
    async retirePrevious(ctx) {
      await local?.retireContainers(ctx, null);
    },

    // With a stable version to restore, the service is simply updated to it
    // (restoreStable). Without one, the service goes back to the task
    // definition it ran before this deployment.
    async discardUnhealthy(ctx, deployed, { restoring = false } = {}) {
      if (restoring) {
        await ctx.log('INFO', `The unhealthy version is replaced on ECS service ${deployed.service}`);
        return;
      }
      await ctx.log(
        'INFO',
        `Stopping unhealthy version: ECS service ${deployed.service} goes back to ` +
          taskDefinitionName(deployed.previousTaskDefinitionArn),
      );
      try {
        await ecsService().pointServiceTo(deployed.service, deployed.previousTaskDefinitionArn);
      } catch (err) {
        await ctx.log('WARN', `Could not take the unhealthy version out of service: ${err.message}`);
      }
    },

    // Deploys the stable deployment's exact image (by digest) to the service.
    async restoreStable(ctx, stable) {
      if (!stable.image_digest) throw new Error('the stable deployment has no image digest recorded');
      if (!(await ecrService().imageExists(stable.image_digest))) {
        throw new Error(`image ${stable.docker_image} of the stable deployment is no longer available in ECR`);
      }
      const repositoryUri = await ecrService().repositoryUri();
      await ctx.log(
        'INFO',
        `Starting stable version from image ${stable.docker_image} (digest ${stable.image_digest.slice(7, 19)})`,
      );
      const { taskDefinitionArn } = await rollOut(ctx, `${repositoryUri}@${stable.image_digest}`);
      await ctx.log('INFO', `ECS service ${ctx.project.aws_ecs_service} runs ${taskDefinitionName(taskDefinitionArn)}`);
      return { started: true, url: ctx.project.aws_service_url, taskDefinitionArn };
    },

    // The service keeps running the restored revision; ROLLBACK_FAILED tells
    // the operator it needs attention.
    async abandonRestored() {},

    async recordRestored(ctx, stable, restored) {
      await recordTaskDefinition(stable.id, restored.taskDefinitionArn);
    },
  };
}
