// Test doubles for AWS deployments, so they need no AWS account, registry or
// network:
//
//   createFakeRegistry()   Amazon ECR: an ECRClient stand-in (send(command))
//                          plus the docker login / tag / push steps the worker
//                          runs against it
//   createFakeEcs()        Amazon ECS: an ECSClient stand-in. Every service is
//                          a real HTTP server on 127.0.0.1 that answers as the
//                          version (image) the service currently runs, so the
//                          worker's real health checks run against it. A
//                          rollout progresses one step per DescribeServices.
//
// Both clients receive the real SDK command objects and dispatch on their
// class name, and both reject what the real services reject (unknown
// repositories, services and images; read-only fields in a new task
// definition), so the code under test has to call them correctly.
//
// How a version behaves is chosen by its commit SHA, as in fakeDocker.js:
//   ecs.setApp(sha, (path, requestNumber) => 500)
import crypto from 'node:crypto';
import http from 'node:http';

export const ACCOUNT_ID = '123456789012';
export const REGION = 'eu-west-1';
export const ECR_PASSWORD = 'ecr-registry-password-9f8e7d';

function awsError(name, message) {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
}

// Commands the test tells a client to fail: { operation: error }.
function createFaults() {
  const faults = new Map();
  return {
    fail(operation, error, { times = Infinity } = {}) {
      faults.set(operation, { error, times });
    },
    clear() {
      faults.clear();
    },
    check(operation) {
      const fault = faults.get(operation);
      if (!fault) return;
      fault.times -= 1;
      if (fault.times <= 0) faults.delete(operation);
      throw fault.error;
    },
  };
}

export function createFakeRegistry({ repository = 'deployx-apps' } = {}) {
  const host = `${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com`;
  const uri = `${host}/${repository}`;
  const localTags = new Map(); // "<uri>:<tag>" -> local image
  const tags = new Map(); // tag -> digest
  const images = new Map(); // digest -> { commit, tags }
  const logins = [];
  const pushes = [];
  const calls = [];
  const faults = createFaults();
  let loggedIn = false;

  function digestOf(localImage) {
    return `sha256:${crypto.createHash('sha256').update(localImage).digest('hex')}`;
  }

  return {
    uri,
    host,
    calls,
    logins,
    pushes,
    faults,

    // ---- the Docker CLI steps (merged into the fake Docker service) ----
    docker: {
      async registryLogin({ registry, username, password }) {
        logins.push({ registry, username, password });
        faults.check('docker login');
        if (registry !== host || username !== 'AWS' || password !== ECR_PASSWORD) {
          throw new Error(`Logging in to ${registry} failed: unauthorized: authentication required`);
        }
        loggedIn = true;
      },
      async tagImage(source, target) {
        localTags.set(target, source);
      },
      async pushImage(reference) {
        faults.check('docker push');
        if (!loggedIn) throw new Error(`Pushing ${reference} failed: no basic auth credentials`);
        const source = localTags.get(reference);
        if (!source || !reference.startsWith(`${uri}:`)) throw new Error(`Pushing ${reference} failed: tag does not exist`);
        const tag = reference.slice(uri.length + 1);
        const digest = digestOf(source);
        const image = images.get(digest) ?? { commit: source.split(':').at(-1), tags: new Set() };
        image.tags.add(tag);
        images.set(digest, image);
        tags.set(tag, digest);
        pushes.push({ reference, source, digest });
      },
    },

    // ---- ECRClient ----
    client: {
      async send(command) {
        const operation = command.constructor.name.replace(/Command$/, '');
        calls.push({ operation, input: structuredClone(command.input) });
        faults.check(operation);
        const { input } = command;
        switch (operation) {
          case 'DescribeRepositories':
            if (input.repositoryNames?.[0] !== repository) {
              throw awsError('RepositoryNotFoundException', `The repository with name '${input.repositoryNames?.[0]}' does not exist`);
            }
            return { repositories: [{ repositoryName: repository, repositoryUri: uri }] };
          case 'GetAuthorizationToken':
            return {
              authorizationData: [
                {
                  authorizationToken: Buffer.from(`AWS:${ECR_PASSWORD}`).toString('base64'),
                  proxyEndpoint: `https://${host}`,
                  expiresAt: new Date(Date.now() + 12 * 3600 * 1000),
                },
              ],
            };
          case 'DescribeImages': {
            if (input.repositoryName !== repository) throw awsError('RepositoryNotFoundException', 'no such repository');
            const [id] = input.imageIds;
            const digest = id.imageDigest ?? tags.get(id.imageTag);
            if (!digest || !images.has(digest)) throw awsError('ImageNotFoundException', 'The image requested does not exist');
            return { imageDetails: [{ imageDigest: digest, imageTags: [...images.get(digest).tags] }] };
          }
          default:
            throw new Error(`fake ECR: unexpected ${operation}`);
        }
      },
    },

    // ---- controls for tests ----
    // The commit an image reference (<uri>@<digest>) was built from.
    commitOf(reference) {
      const digest = reference?.startsWith(`${uri}@`) ? reference.slice(uri.length + 1) : null;
      return images.get(digest)?.commit ?? null;
    },
    digestOfTag(tag) {
      return tags.get(tag) ?? null;
    },
    // A lifecycle policy (or a person) deleted the image.
    deleteImage(digest) {
      for (const tag of images.get(digest)?.tags ?? []) tags.delete(tag);
      images.delete(digest);
    },
  };
}

// Fields ECS sets itself; RegisterTaskDefinition refuses them.
const READ_ONLY_TASK_DEFINITION_FIELDS = [
  'taskDefinitionArn',
  'revision',
  'status',
  'registeredAt',
  'registeredBy',
  'requiresAttributes',
  'compatibilities',
  'deregisteredAt',
];

export function createFakeEcs({ registry, cluster = 'deployx-cluster' }) {
  const services = new Map();
  const taskDefinitions = new Map(); // ARN -> { taskDefinition, tags }
  const revisions = new Map(); // family -> latest revision
  const apps = new Map(); // commit -> app
  const failingCommits = new Set(); // tasks of these versions never start
  const stuckCommits = new Set(); // rollouts of these versions never finish
  const calls = [];
  const faults = createFaults();
  let deploymentCounter = 0;

  function register(input) {
    for (const field of READ_ONLY_TASK_DEFINITION_FIELDS) {
      if (field in input) throw awsError('ClientException', `Unexpected field ${field} in RegisterTaskDefinition`);
    }
    if (!input.family || !input.containerDefinitions?.length) throw awsError('ClientException', 'family and containerDefinitions are required');
    const revision = (revisions.get(input.family) ?? 0) + 1;
    revisions.set(input.family, revision);
    const arn = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${input.family}:${revision}`;
    const { tags = [], ...definition } = structuredClone(input);
    const taskDefinition = {
      ...definition,
      taskDefinitionArn: arn,
      revision,
      status: 'ACTIVE',
      registeredAt: new Date(),
      registeredBy: `arn:aws:iam::${ACCOUNT_ID}:user/deployx`,
      requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.docker-remote-api.1.18' }],
      compatibilities: ['EC2', 'FARGATE'],
    };
    taskDefinitions.set(arn, { taskDefinition, tags });
    return taskDefinition;
  }

  function appImage(arn) {
    return taskDefinitions.get(arn).taskDefinition.containerDefinitions.find((container) => container.name === 'app').image;
  }

  function commitRunning(service) {
    return registry.commitOf(appImage(service.running));
  }

  // One step of every rollout in progress: pending -> running -> COMPLETED,
  // or FAILED for a version whose tasks do not start.
  function advance(service) {
    for (const deployment of service.deployments) {
      // A deployment replaced by a newer one (no longer PRIMARY) is drained.
      if (deployment.rolloutState !== 'IN_PROGRESS' || deployment.status !== 'PRIMARY') continue;
      deployment.steps += 1;
      const commit = registry.commitOf(appImage(deployment.taskDefinition));
      if (stuckCommits.has(commit)) {
        deployment.pendingCount = 1;
      } else if (failingCommits.has(commit)) {
        deployment.pendingCount = deployment.steps < 2 ? 1 : 0;
        if (deployment.steps >= 2) {
          deployment.failedTasks = 2;
          deployment.rolloutState = 'FAILED';
          deployment.rolloutStateReason = 'ECS deployment circuit breaker: tasks failed to start.';
          service.events.unshift({
            message: `(service ${service.serviceName}) is unable to consistently start tasks successfully.`,
          });
        }
      } else if (deployment.steps === 1) {
        deployment.pendingCount = 1;
      } else {
        deployment.pendingCount = 0;
        deployment.runningCount = 1;
        deployment.rolloutState = 'COMPLETED';
        service.running = deployment.taskDefinition;
        service.history.push(deployment.taskDefinition);
        service.deployments = [deployment];
      }
    }
  }

  function view(service) {
    const { server, history, requests, running, updates, ...rest } = service;
    return structuredClone({ ...rest, deployments: rest.deployments.map(({ steps, ...deployment }) => deployment) });
  }

  return {
    cluster,
    calls,
    faults,

    // ---- ECSClient ----
    client: {
      async send(command) {
        const operation = command.constructor.name.replace(/Command$/, '');
        calls.push({ operation, input: structuredClone(command.input) });
        faults.check(operation);
        const { input } = command;
        if ('cluster' in input && input.cluster !== cluster) {
          throw awsError('ClusterNotFoundException', 'Cluster not found.');
        }
        switch (operation) {
          case 'DescribeServices': {
            const found = [];
            const failures = [];
            for (const name of input.services) {
              const service = services.get(name);
              if (!service) {
                failures.push({ arn: name, reason: 'MISSING' });
                continue;
              }
              advance(service);
              found.push(view(service));
            }
            return { services: found, failures };
          }
          case 'DescribeTaskDefinition': {
            const entry = taskDefinitions.get(input.taskDefinition);
            if (!entry) throw awsError('ClientException', 'Unable to describe task definition.');
            return structuredClone({ taskDefinition: entry.taskDefinition, tags: input.include?.includes('TAGS') ? entry.tags : undefined });
          }
          case 'RegisterTaskDefinition':
            return { taskDefinition: structuredClone(register(input)) };
          case 'UpdateService': {
            const service = services.get(input.service);
            if (!service) throw awsError('ServiceNotFoundException', 'Service not found.');
            if (!taskDefinitions.has(input.taskDefinition)) throw awsError('ClientException', 'TaskDefinition not found.');
            for (const deployment of service.deployments) if (deployment.status === 'PRIMARY') deployment.status = 'ACTIVE';
            deploymentCounter += 1;
            service.deployments.unshift({
              id: `ecs-svc/${String(deploymentCounter).padStart(19, '0')}`,
              status: 'PRIMARY',
              taskDefinition: input.taskDefinition,
              desiredCount: 1,
              pendingCount: 0,
              runningCount: 0,
              failedTasks: 0,
              rolloutState: 'IN_PROGRESS',
              steps: 0,
            });
            service.taskDefinition = input.taskDefinition;
            service.updates.push(input.taskDefinition);
            return { service: view(service) };
          }
          default:
            throw new Error(`fake ECS: unexpected ${operation}`);
        }
      },
    },

    // ---- setup and controls for tests ----
    // An ECS service as an operator would create it: a task definition with
    // the app container (placeholder image) and a log-router sidecar, a
    // running deployment, and a URL. Returns { name, url }.
    async addService(name, { containerPort = 3000 } = {}) {
      const initial = register({
        family: name,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: '256',
        memory: '512',
        executionRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole`,
        containerDefinitions: [
          {
            name: 'log-router',
            image: 'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable',
            essential: false,
          },
          {
            name: 'app',
            image: 'public.ecr.aws/docker/library/nginx:latest',
            essential: true,
            portMappings: [{ containerPort, protocol: 'tcp' }],
            environment: [{ name: 'NODE_ENV', value: 'production' }],
          },
        ],
        tags: [{ key: 'team', value: 'web' }],
      });
      const service = {
        serviceName: name,
        serviceArn: `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/${cluster}/${name}`,
        clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${cluster}`,
        status: 'ACTIVE',
        desiredCount: 1,
        taskDefinition: initial.taskDefinitionArn,
        deployments: [
          {
            id: `ecs-svc/initial-${name}`,
            status: 'PRIMARY',
            taskDefinition: initial.taskDefinitionArn,
            desiredCount: 1,
            pendingCount: 0,
            runningCount: 1,
            failedTasks: 0,
            rolloutState: 'COMPLETED',
            steps: 0,
          },
        ],
        events: [],
        running: initial.taskDefinitionArn,
        history: [initial.taskDefinitionArn],
        updates: [],
        requests: [],
      };
      service.server = http.createServer(async (req, res) => {
        const commit = commitRunning(service);
        service.requests.push({ path: req.url, commit });
        const status = commit ? await (apps.get(commit) ?? (() => 200))(req.url, service.requests.length) : 200;
        if (status === 'hang' || res.destroyed) return;
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`${commit ?? 'placeholder'}\n`);
      });
      await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
      services.set(name, service);
      return { name, url: `http://127.0.0.1:${service.server.address().port}`, initialTaskDefinition: initial.taskDefinitionArn };
    },

    setApp(commit, app) {
      apps.set(commit, app);
    },
    failTasks(commit) {
      failingCommits.add(commit);
    },
    stickRollout(commit) {
      stuckCommits.add(commit);
    },
    service(name) {
      return services.get(name);
    },
    taskDefinition(arn) {
      return taskDefinitions.get(arn)?.taskDefinition ?? null;
    },
    tagsOf(arn) {
      return taskDefinitions.get(arn)?.tags ?? null;
    },
    // The commit the service's app container runs now (null: the placeholder).
    commitRunning(name) {
      return commitRunning(services.get(name));
    },
    appImage,
    async close() {
      for (const service of services.values()) {
        service.server.closeAllConnections();
        await new Promise((resolve) => service.server.close(resolve));
      }
    },
  };
}
