import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { awsClientOptions, awsError } from '../lib/awsErrors.js';
import { activeJobSignal } from '../lib/jobContext.js';

// Amazon ECS (Fargate or EC2): runs AWS_ECS deployments.
//
// DeployX does not create AWS infrastructure. The cluster (AWS_ECS_CLUSTER)
// and one service per project - with its networking, load balancer, IAM roles,
// CPU and memory - are set up once by the operator. A deployment then changes
// exactly one thing, the image:
//
//   DescribeServices        the service and the task definition it runs now
//   DescribeTaskDefinition  that task definition
//   RegisterTaskDefinition  a new revision of it, with the app container's image
//                           replaced by <ecr-repository>@<digest>
//   UpdateService           the service runs the new revision (a rolling update)
//   DescribeServices ...    until the rollout completed, failed or timed out
//
// Deploying an older image (a rollback) is the same operation with that
// image's digest.
//
// All ECS calls of the worker are in this file. `client` is an ECSClient
// (replaced by a fake in tests).

// What RegisterTaskDefinition accepts of a described task definition. Fields
// ECS adds itself (ARN, revision, status, registeredAt, ...) are left out.
const TASK_DEFINITION_FIELDS = [
  'family',
  'taskRoleArn',
  'executionRoleArn',
  'networkMode',
  'containerDefinitions',
  'volumes',
  'placementConstraints',
  'requiresCompatibilities',
  'cpu',
  'memory',
  'pidMode',
  'ipcMode',
  'proxyConfiguration',
  'inferenceAccelerators',
  'ephemeralStorage',
  'runtimePlatform',
  'enableFaultInjection',
];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An ECS rollout that failed or did not finish in time. Another attempt may
// succeed, so it is retried like a container that failed to start.
// `taskDefinitionArn` is the revision that was being rolled out,
// `previousTaskDefinitionArn` what the service ran before.
export class EcsRolloutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EcsRolloutError';
  }
}

// arn:aws:ecs:...:task-definition/my-app:7 -> my-app:7
export function taskDefinitionName(arn) {
  return String(arn ?? '').split('/').pop();
}

// The latest event ECS reported for the service, e.g. why tasks do not start.
function latestEvent(service) {
  const message = service.events?.[0]?.message;
  return message ? message.replace(/^\(service [^)]*\) /, '') : null;
}

export function createAwsDeploymentService({
  client,
  cluster = config.aws.ecsCluster,
  timeoutMs = config.aws.deployTimeoutMs,
  pollIntervalMs = config.aws.pollIntervalMs,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  let ecs = client;
  const ecsClient = () => (ecs ??= new ECSClient(awsClientOptions()));

  async function send(operation, command) {
    try {
      return await ecsClient().send(command);
    } catch (err) {
      throw awsError(`ECS ${operation}`, err);
    }
  }

  async function describeService(service) {
    const { services } = await send('DescribeServices', new DescribeServicesCommand({ cluster, services: [service] }));
    const found = services?.[0];
    if (found?.status !== 'ACTIVE') {
      const state = found ? ` (status ${found.status})` : '';
      throw new UnrecoverableError(`ECS service ${service} was not found in cluster ${cluster}${state}`);
    }
    return found;
  }

  // Registers a revision of `taskDefinitionArn` whose app container runs
  // `image`. The app container is the only container, or the one that maps
  // `containerPort` (the project's port); every other setting is copied.
  async function registerRevision(taskDefinitionArn, { image, containerPort }) {
    const { taskDefinition, tags } = await send(
      'DescribeTaskDefinition',
      new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn, include: ['TAGS'] }),
    );
    const containers = taskDefinition?.containerDefinitions ?? [];
    const app =
      containers.length === 1
        ? containers[0]
        : containers.find((container) => container.portMappings?.some((mapping) => mapping.containerPort === containerPort));
    if (!app) {
      throw new UnrecoverableError(
        `Task definition ${taskDefinitionName(taskDefinitionArn)} has no container for port ${containerPort}; ` +
          "set the project's container_port to the app container's port",
      );
    }

    const input = {};
    for (const field of TASK_DEFINITION_FIELDS) {
      if (taskDefinition[field] !== undefined && taskDefinition[field] !== null) input[field] = taskDefinition[field];
    }
    input.containerDefinitions = containers.map((container) => (container === app ? { ...container, image } : container));
    if (tags?.length) input.tags = tags;

    const registered = await send('RegisterTaskDefinition', new RegisterTaskDefinitionCommand(input));
    const arn = registered.taskDefinition?.taskDefinitionArn;
    if (!arn) throw new Error('ECS RegisterTaskDefinition returned no task definition');
    return { arn, container: app.name };
  }

  // Follows ECS deployment `deploymentId` of `service` until its rollout
  // completed. Progress (running / pending / failed tasks) is reported
  // through `onLog` whenever it changes.
  async function waitForRollout({ service, deploymentId, onLog }) {
    const started = now();
    const signal = activeJobSignal();
    let reported = null;
    for (;;) {
      if (signal?.aborted) {
        throw new EcsRolloutError(`ECS rollout of service ${service} stopped: the deployment timed out`);
      }
      const current = await describeService(service);
      const deployment = current.deployments?.find((candidate) => candidate.id === deploymentId);
      if (!deployment) {
        throw new EcsRolloutError(`ECS deployment ${deploymentId} was replaced by another deployment of service ${service}`);
      }

      const failed = deployment.failedTasks ?? 0;
      const progress =
        `${deployment.runningCount ?? 0}/${deployment.desiredCount ?? 0} tasks running, ` +
        `${deployment.pendingCount ?? 0} pending${failed ? `, ${failed} failed to start` : ''}`;
      if (progress !== reported) {
        await onLog(failed ? 'WARN' : 'INFO', `AWS deployment progressing: ${progress}`);
        reported = progress;
      }

      // Checked first: the ECS circuit breaker (with rollback enabled) marks a
      // failed deployment FAILED and starts a rollback deployment in one step.
      if (deployment.rolloutState === 'FAILED') {
        throw new EcsRolloutError(
          `ECS rollout failed: ${deployment.rolloutStateReason ?? latestEvent(current) ?? 'no reason given'}`,
        );
      }
      // A newer deployment of the service (from anywhere) makes this one
      // non-PRIMARY: whatever it ends up running is not this version.
      if (deployment.status !== 'PRIMARY') {
        throw new EcsRolloutError(`ECS deployment ${deploymentId} was replaced by another deployment of service ${service}`);
      }
      // rolloutState is not reported for every kind of service; without it the
      // rollout is done once this deployment is the only one and fully running.
      const completed =
        deployment.rolloutState === 'COMPLETED' ||
        (!deployment.rolloutState &&
          current.deployments.length === 1 &&
          (deployment.runningCount ?? 0) === (deployment.desiredCount ?? 0));
      if (completed) {
        await onLog('INFO', `ECS rollout completed: ${deployment.runningCount ?? 0}/${deployment.desiredCount ?? 0} tasks running`);
        return;
      }

      if (now() - started >= timeoutMs) {
        const event = latestEvent(current);
        throw new EcsRolloutError(
          `ECS deployment did not complete within ${timeoutMs / 1000}s (${progress})${event ? `: ${event}` : ''}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    cluster,

    // Runs `image` on ECS service `service` and waits until the rollout has
    // completed. Returns { taskDefinitionArn, previousTaskDefinitionArn }.
    // A failed or timed-out rollout throws EcsRolloutError carrying both ARNs.
    async deployImage({ service, image, containerPort, onLog = async () => {} }) {
      const current = await describeService(service);
      const previousTaskDefinitionArn = current.taskDefinition;
      const { arn, container } = await registerRevision(previousTaskDefinitionArn, { image, containerPort });
      await onLog('INFO', `Registered task definition ${taskDefinitionName(arn)} (container ${container})`);

      const { service: updated } = await send(
        'UpdateService',
        new UpdateServiceCommand({ cluster, service, taskDefinition: arn }),
      );
      const deployment =
        updated?.deployments?.find((candidate) => candidate.status === 'PRIMARY' && candidate.taskDefinition === arn) ??
        updated?.deployments?.find((candidate) => candidate.taskDefinition === arn);
      if (!deployment?.id) throw new Error(`ECS did not start a deployment of ${taskDefinitionName(arn)}`);
      await onLog('INFO', `ECS deployment ${deployment.id} started; waiting for the new tasks`);

      try {
        await waitForRollout({ service, deploymentId: deployment.id, onLog });
      } catch (err) {
        err.taskDefinitionArn = arn;
        err.previousTaskDefinitionArn = previousTaskDefinitionArn;
        throw err;
      }
      return { taskDefinitionArn: arn, previousTaskDefinitionArn };
    },

    // Points `service` at `taskDefinitionArn` without waiting for the rollout
    // (used to take a version that failed back out of service).
    async pointServiceTo(service, taskDefinitionArn) {
      await send('UpdateService', new UpdateServiceCommand({ cluster, service, taskDefinition: taskDefinitionArn }));
    },
  };
}
