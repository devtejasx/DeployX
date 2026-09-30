// Unit tests for the worker's AWS building blocks: the ECR service, the ECS
// deployment service, AWS error handling, the AWS_ECS target's checks and the
// health check of service URLs. The AWS SDK clients are replaced by the fakes
// in fakeAws.js: no AWS credentials, account or network are needed.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
// The worker has its own copy of bullmq, so its errors are recognised by name.
const isUnrecoverable = (err) => err?.name === 'UnrecoverableError';
import { ECR_PASSWORD, createFakeEcs, createFakeRegistry } from './fakeAws.js';

process.env.AWS_REGION = 'eu-west-1';
process.env.AWS_ECR_REPOSITORY = 'deployx-apps';
process.env.AWS_ECS_CLUSTER = 'deployx-cluster';

const { default: workerConfig } = await import('../../worker/src/config/index.js');
const { createEcrService } = await import('../../worker/src/services/ecrService.js');
const { EcsRolloutError, createAwsDeploymentService, taskDefinitionName } = await import(
  '../../worker/src/services/awsDeploymentService.js'
);
const { awsError } = await import('../../worker/src/lib/awsErrors.js');
const { createAwsEcsTarget } = await import('../../worker/src/targets/awsEcsTarget.js');
const { checkServiceHealth, classifyAddress, serviceHealthCheckUrl, waitForHealthy } = await import(
  '../../worker/src/services/healthCheckService.js'
);

const LOCAL_IMAGE = 'deployx/my-api-0f8fad5b:abc123def456';
const TAGS = ['my-api-0f8fad5b-abc123def456', 'my-api-0f8fad5b-deployment-7c9e6679-7425-40de-944b-e07fc1f90ae7'];

let registry;
let ecs;

before(() => {
  registry = createFakeRegistry();
  ecs = createFakeEcs({ registry });
});

after(() => ecs.close());

function ecrService(options = {}) {
  return createEcrService({ client: registry.client, docker: registry.docker, ...options });
}

function ecsService(options = {}) {
  return createAwsDeploymentService({
    client: ecs.client,
    cluster: 'deployx-cluster',
    pollIntervalMs: 1,
    timeoutMs: 2000,
    ...options,
  });
}

function logRecorder() {
  const lines = [];
  return { lines, onLog: async (level, message) => lines.push(`${level} ${message}`) };
}

describe('ECR', () => {
  test('logs Docker in with a registry token passed on stdin, never as an argument', async () => {
    await ecrService().login();
    assert.deepEqual(registry.logins.at(-1), { registry: registry.host, username: 'AWS', password: ECR_PASSWORD });
    assert.deepEqual(
      registry.calls.slice(-2).map((call) => call.operation),
      ['DescribeRepositories', 'GetAuthorizationToken'],
    );
  });

  test('pushes the image under its commit and deployment tags and reports the digest ECR stores', async () => {
    const { reference, digest } = await ecrService().push(LOCAL_IMAGE, TAGS);
    assert.equal(reference, `${registry.uri}:${TAGS[0]}`);
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      registry.pushes.slice(-2).map((push) => push.reference),
      TAGS.map((tag) => `${registry.uri}:${tag}`),
    );
    // Both tags name the same image; the digest is what ECR says, not a guess.
    assert.equal(registry.digestOfTag(TAGS[0]), digest);
    assert.equal(registry.digestOfTag(TAGS[1]), digest);
    assert.deepEqual(registry.calls.at(-1), {
      operation: 'DescribeImages',
      input: { repositoryName: 'deployx-apps', imageIds: [{ imageTag: TAGS[0] }] },
    });
    assert.equal(await ecrService().imageExists(digest), true);
    registry.deleteImage(digest);
    assert.equal(await ecrService().imageExists(digest), false);
  });

  test('a push without an image in ECR afterwards is an error', async () => {
    registry.faults.fail('DescribeImages', Object.assign(new Error('The image requested does not exist'), { name: 'ImageNotFoundException' }), { times: 1 });
    await assert.rejects(ecrService().push(LOCAL_IMAGE, TAGS), { message: `ECR has no image tagged ${TAGS[0]} after the push` });
  });

  test('a missing repository fails for good; throttling and push failures can be retried', async () => {
    const missing = ecrService({ repository: 'nope' }).login();
    await assert.rejects(missing, (err) => {
      assert.ok(isUnrecoverable(err));
      assert.equal(err.message, "ECR DescribeRepositories failed: RepositoryNotFoundException: The repository with name 'nope' does not exist");
      return true;
    });

    registry.faults.fail('GetAuthorizationToken', Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }), { times: 1 });
    await assert.rejects(ecrService().login(), (err) => {
      assert.ok(!isUnrecoverable(err));
      assert.equal(err.message, 'ECR GetAuthorizationToken failed: ThrottlingException: Rate exceeded');
      return true;
    });

    registry.faults.fail('docker push', new Error('Pushing failed: net/http: TLS handshake timeout'), { times: 1 });
    await assert.rejects(ecrService().push(LOCAL_IMAGE, TAGS), { message: 'Pushing failed: net/http: TLS handshake timeout' });
  });
});

describe('ECS deployments', () => {
  test("registers a revision of the service's task definition with only the app image replaced, and waits for the rollout", async () => {
    const { name, initialTaskDefinition } = await ecs.addService('svc-deploy', { containerPort: 3000 });
    const image = `${registry.uri}@sha256:${'a'.repeat(64)}`;
    const { lines, onLog } = logRecorder();

    const result = await ecsService().deployImage({ service: name, image, containerPort: 3000, onLog });

    assert.equal(result.previousTaskDefinitionArn, initialTaskDefinition);
    assert.equal(taskDefinitionName(result.taskDefinitionArn), 'svc-deploy:2');
    assert.equal(ecs.service(name).running, result.taskDefinitionArn);

    const before = ecs.taskDefinition(initialTaskDefinition);
    const after = ecs.taskDefinition(result.taskDefinitionArn);
    const strip = ({ taskDefinitionArn, revision, registeredAt, containerDefinitions, ...rest }) => rest;
    assert.deepEqual(strip(after), strip(before));
    assert.deepEqual(after.containerDefinitions, [
      before.containerDefinitions[0],
      { ...before.containerDefinitions[1], image },
    ]);
    assert.deepEqual(ecs.tagsOf(result.taskDefinitionArn), [{ key: 'team', value: 'web' }]);

    const update = ecs.calls.find((call) => call.operation === 'UpdateService' && call.input.service === name);
    assert.deepEqual(update.input, { cluster: 'deployx-cluster', service: name, taskDefinition: result.taskDefinitionArn });
    assert.deepEqual(lines, [
      'INFO Registered task definition svc-deploy:2 (container app)',
      `INFO ECS deployment ${ecs.service(name).deployments[0].id} started; waiting for the new tasks`,
      'INFO AWS deployment progressing: 0/1 tasks running, 1 pending',
      'INFO AWS deployment progressing: 1/1 tasks running, 0 pending',
      'INFO ECS rollout completed: 1/1 tasks running',
    ]);
  });

  test('a rollout whose tasks do not start fails with the reason and both task definitions', async () => {
    const { name, initialTaskDefinition } = await ecs.addService('svc-failing');
    await registry.docker.tagImage('fake/failing:bad', `${registry.uri}:bad`);
    await registry.docker.registryLogin({ registry: registry.host, username: 'AWS', password: ECR_PASSWORD });
    await registry.docker.pushImage(`${registry.uri}:bad`);
    ecs.failTasks('bad');
    const { lines, onLog } = logRecorder();

    const deploying = ecsService().deployImage({
      service: name,
      image: `${registry.uri}@${registry.digestOfTag('bad')}`,
      containerPort: 3000,
      onLog,
    });
    await assert.rejects(deploying, (err) => {
      assert.ok(err instanceof EcsRolloutError);
      assert.ok(!isUnrecoverable(err), 'a failed rollout may be retried');
      assert.equal(err.message, 'ECS rollout failed: ECS deployment circuit breaker: tasks failed to start.');
      assert.equal(err.previousTaskDefinitionArn, initialTaskDefinition);
      assert.equal(taskDefinitionName(err.taskDefinitionArn), 'svc-failing:2');
      return true;
    });
    assert.ok(lines.includes('WARN AWS deployment progressing: 0/1 tasks running, 0 pending, 2 failed to start'), lines.join('\n'));
    // The service still serves the version it ran before.
    assert.equal(ecs.service(name).running, initialTaskDefinition);
  });

  test('a rollout the ECS circuit breaker rolled back itself reports the failure, not a replacement', async () => {
    const { name } = await ecs.addService('svc-circuit-breaker');
    // With rollback enabled, ECS demotes the failed deployment as it fails.
    const client = {
      async send(command) {
        const result = await ecs.client.send(command);
        for (const service of result.services ?? []) {
          for (const deployment of service.deployments) {
            if (deployment.rolloutState === 'FAILED') deployment.status = 'ACTIVE';
          }
        }
        return result;
      },
    };
    await assert.rejects(
      ecsService({ client }).deployImage({
        service: name,
        image: `${registry.uri}@${registry.digestOfTag('bad')}`,
        containerPort: 3000,
      }),
      { name: 'EcsRolloutError', message: 'ECS rollout failed: ECS deployment circuit breaker: tasks failed to start.' },
    );
  });

  test('a rollout that does not finish in time fails', async () => {
    const { name } = await ecs.addService('svc-stuck');
    await registry.docker.tagImage('fake/stuck:slow', `${registry.uri}:slow`);
    await registry.docker.pushImage(`${registry.uri}:slow`);
    ecs.stickRollout('slow');

    await assert.rejects(
      ecsService({ timeoutMs: 150, pollIntervalMs: 10 }).deployImage({
        service: name,
        image: `${registry.uri}@${registry.digestOfTag('slow')}`,
        containerPort: 3000,
      }),
      { name: 'EcsRolloutError', message: 'ECS deployment did not complete within 0.15s (0/1 tasks running, 1 pending)' },
    );
  });

  test('a rollout replaced by another deployment of the same service fails', async () => {
    const { name, initialTaskDefinition } = await ecs.addService('svc-replaced');
    let describes = 0;
    const client = {
      async send(command) {
        if (command.constructor.name === 'DescribeServicesCommand' && ++describes === 3) {
          // Someone else deploys to the service meanwhile.
          await ecsService().pointServiceTo(name, initialTaskDefinition);
        }
        return ecs.client.send(command);
      },
    };
    await assert.rejects(
      ecsService({ client }).deployImage({ service: name, image: `${registry.uri}@sha256:${'b'.repeat(64)}`, containerPort: 3000 }),
      { name: 'EcsRolloutError', message: /^ECS deployment ecs-svc\/\d+ was replaced by another deployment of service svc-replaced$/ },
    );
  });

  test('services without a rollout state are done once the new deployment runs alone', async () => {
    const { name } = await ecs.addService('svc-no-rollout-state');
    const client = {
      async send(command) {
        const result = await ecs.client.send(command);
        for (const service of result.services ?? []) {
          for (const deployment of service.deployments) delete deployment.rolloutState;
        }
        return result;
      },
    };
    const result = await ecsService({ client }).deployImage({ service: name, image: `${registry.uri}@sha256:${'c'.repeat(64)}`, containerPort: 3000 });
    assert.equal(taskDefinitionName(result.taskDefinitionArn), 'svc-no-rollout-state:2');
  });

  test('a missing service or cluster, or no container for the port, fails for good', async () => {
    const { name } = await ecs.addService('svc-checks', { containerPort: 3000 });
    const deploy = (options) =>
      ecsService(options.service ? {} : options).deployImage({
        service: options.service ?? name,
        image: `${registry.uri}@sha256:${'d'.repeat(64)}`,
        containerPort: options.containerPort ?? 3000,
      });

    for (const [options, message] of [
      [{ service: 'no-such-service' }, 'ECS service no-such-service was not found in cluster deployx-cluster'],
      [{ cluster: 'other-cluster' }, 'ECS DescribeServices failed: ClusterNotFoundException: Cluster not found.'],
      [
        { containerPort: 8080 },
        "Task definition svc-checks:1 has no container for port 8080; set the project's container_port to the app container's port",
      ],
    ]) {
      await assert.rejects(deploy(options), (err) => {
        assert.ok(isUnrecoverable(err), message);
        assert.equal(err.message, message);
        return true;
      });
    }
  });

  test('AWS API errors: throttling is retried, missing permissions are not', async () => {
    const { name } = await ecs.addService('svc-errors');
    const image = `${registry.uri}@sha256:${'e'.repeat(64)}`;
    ecs.faults.fail('UpdateService', Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }), { times: 1 });
    await assert.rejects(ecsService().deployImage({ service: name, image, containerPort: 3000 }), (err) => {
      assert.ok(!isUnrecoverable(err));
      assert.equal(err.message, 'ECS UpdateService failed: ThrottlingException: Rate exceeded');
      return true;
    });

    ecs.faults.fail(
      'RegisterTaskDefinition',
      Object.assign(new Error('User is not authorized to perform: ecs:RegisterTaskDefinition'), { name: 'AccessDeniedException' }),
      { times: 1 },
    );
    await assert.rejects(ecsService().deployImage({ service: name, image, containerPort: 3000 }), (err) => {
      assert.ok(isUnrecoverable(err));
      assert.match(err.message, /^ECS RegisterTaskDefinition failed: AccessDeniedException: /);
      return true;
    });
  });

  test('AWS errors keep only the name and message AWS returned', () => {
    const err = awsError('ECS UpdateService', Object.assign(new Error('Service not found.'), { name: 'ServiceNotFoundException' }));
    assert.ok(isUnrecoverable(err));
    assert.equal(err.message, 'ECS UpdateService failed: ServiceNotFoundException: Service not found.');
    const network = awsError('ECR GetAuthorizationToken', new Error('getaddrinfo ENOTFOUND api.ecr.eu-west-1.amazonaws.com'));
    assert.ok(!isUnrecoverable(network));
    assert.equal(network.message, 'ECR GetAuthorizationToken failed: getaddrinfo ENOTFOUND api.ecr.eu-west-1.amazonaws.com');
    assert.ok(isUnrecoverable(awsError('x', Object.assign(new Error('x'), { name: 'CredentialsProviderError' }))));
  });
});

describe('AWS_ECS target checks', () => {
  const project = {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    name: 'My API',
    container_port: 3000,
    aws_ecs_service: 'my-api',
    aws_service_url: 'https://my-api.example.com',
  };

  test('refuses to deploy without the worker settings or the project settings', () => {
    const target = createAwsEcsTarget({ ecr: {}, ecs: {} });
    target.validate(project);

    const saved = { ...workerConfig.aws };
    try {
      workerConfig.aws.ecsCluster = '';
      workerConfig.aws.region = '';
      assert.throws(() => target.validate(project), {
        name: 'UnrecoverableError',
        message: 'AWS deployments are not configured on this worker: set AWS_REGION, AWS_ECS_CLUSTER',
      });
    } finally {
      Object.assign(workerConfig.aws, saved);
    }

    assert.throws(() => target.validate({ ...project, aws_ecs_service: null }), {
      message: 'Project has no AWS ECS service or service URL configured; set them with PUT /api/projects/:id',
    });
    assert.throws(() => target.validate({ ...project, container_port: null }), { name: 'UnrecoverableError' });
    assert.throws(() => target.validate({ ...project, aws_service_url: 'https://x.example.com/path' }), {
      name: 'UnrecoverableError',
      message: /^Invalid AWS service URL: /,
    });
  });
});

describe('health checks of service URLs', () => {
  let server;
  let port;
  const requests = [];

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, host: req.headers.host });
      res.writeHead(req.url === '/health' ? 200 : 503).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('addresses are public, private, or never allowed', () => {
    for (const [address, kind] of [
      ['8.8.8.8', 'public'],
      ['2606:4700:4700::1111', 'public'],
      ['10.1.2.3', 'private'],
      ['172.31.0.5', 'private'],
      ['192.168.1.1', 'private'],
      ['127.0.0.1', 'private'],
      ['100.64.0.1', 'private'],
      ['::1', 'private'],
      ['fd12:3456::1', 'private'],
      ['169.254.169.254', 'forbidden'],
      ['::ffff:169.254.169.254', 'forbidden'],
      ['fd00:ec2::254', 'forbidden'],
      ['fe80::1', 'forbidden'],
      ['0.0.0.0', 'forbidden'],
      ['224.0.0.1', 'forbidden'],
      ['not-an-ip', 'forbidden'],
    ]) {
      assert.equal(classifyAddress(address), kind, address);
    }
  });

  test('only an http(s) origin plus a plain path makes a service health-check URL', () => {
    assert.equal(serviceHealthCheckUrl({ baseUrl: 'https://my-api.example.com', path: '/health' }).href, 'https://my-api.example.com/health');
    assert.equal(serviceHealthCheckUrl({ baseUrl: 'http://my-api.example.com:8080', path: '/a?b=1' }).href, 'http://my-api.example.com:8080/a?b=1');
    for (const [baseUrl, path] of [
      ['https://my-api.example.com/', '/health'],
      ['https://user:pw@my-api.example.com', '/health'],
      ['ftp://my-api.example.com', '/health'],
      ['https://my-api.example.com', '//evil.example.com/'],
      ['https://my-api.example.com', 'health'],
      ['not a url', '/health'],
    ]) {
      assert.throws(() => serviceHealthCheckUrl({ baseUrl, path }), { name: 'HealthCheckTargetError' }, `${baseUrl} ${path}`);
    }
  });

  test('the request goes to the address that was checked, with the service host name', async () => {
    const lookups = [];
    const lookup = async (hostname) => {
      lookups.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const result = await checkServiceHealth({
      baseUrl: `http://my-api.example.test:${port}`,
      path: '/health',
      allowPrivate: true,
      lookup,
    });
    assert.equal(result.healthy, true, result.error);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(lookups, ['my-api.example.test']);
    assert.deepEqual(requests.at(-1), { url: '/health', host: `my-api.example.test:${port}` });
  });

  test('private addresses are refused unless allowed, link-local ones always, and nothing is requested', async () => {
    const count = requests.length;
    const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

    const privateHost = await checkServiceHealth({ baseUrl: `http://internal.example.test:${port}`, path: '/health', allowPrivate: false, lookup: resolvesTo('127.0.0.1') });
    assert.equal(privateHost.healthy, false);
    assert.equal(
      privateHost.error,
      'internal.example.test resolves to the private address 127.0.0.1 (set HEALTH_CHECK_ALLOW_PRIVATE_URLS=true if the service is only reachable privately)',
    );

    for (const address of ['169.254.169.254', 'fd00:ec2::254']) {
      const metadata = await checkServiceHealth({ baseUrl: `http://metadata.example.test:${port}`, path: '/health', allowPrivate: true, lookup: resolvesTo(address) });
      assert.equal(metadata.error, `metadata.example.test resolves to ${address}, which health checks may not reach`);
    }

    // One bad address among good ones is enough to refuse (DNS rebinding).
    const mixed = await checkServiceHealth({ baseUrl: `http://mixed.example.test:${port}`, path: '/health', allowPrivate: false, lookup: resolvesTo('8.8.8.8', '10.0.0.7') });
    assert.match(mixed.error, /resolves to the private address 10\.0\.0\.7/);

    const literal = await checkServiceHealth({ baseUrl: 'http://169.254.169.254', path: '/latest/meta-data', allowPrivate: true });
    assert.equal(literal.error, '169.254.169.254 resolves to 169.254.169.254, which health checks may not reach');

    const unknown = await checkServiceHealth({
      baseUrl: 'http://unknown.example.test',
      path: '/health',
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND unknown.example.test'), { code: 'ENOTFOUND' });
      },
    });
    assert.equal(unknown.error, 'Could not resolve unknown.example.test: ENOTFOUND');

    assert.equal(requests.length, count, 'no request may be sent to a refused address');
  });

  test('waitForHealthy checks a service URL with the same retries, and refuses private URLs by default', async () => {
    assert.equal(workerConfig.healthCheck.allowPrivateUrls, false);
    const result = await waitForHealthy({
      baseUrl: `http://127.0.0.1:${port}`,
      path: '/health',
      retries: 2,
      startupGracePeriod: 0,
      interval: 1,
    });
    assert.equal(result.healthy, false);
    assert.equal(result.attempts, 2);
    assert.match(result.error, /^127\.0\.0\.1 resolves to the private address 127\.0\.0\.1/);

    const checks = [];
    await waitForHealthy({
      baseUrl: 'https://my-api.example.com',
      path: '/health',
      retries: 1,
      startupGracePeriod: 0,
      check: async (target) => {
        checks.push(target);
        return { healthy: true, statusCode: 200, responseTime: 1 };
      },
    });
    assert.deepEqual(checks, [{ baseUrl: 'https://my-api.example.com', path: '/health', timeout: workerConfig.healthCheck.timeoutMs }]);
  });
});
