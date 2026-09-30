// GitHub push -> AWS deployment, end to end:
//
//   signed webhook -> API -> PostgreSQL -> BullMQ -> worker -> build
//     -> ECR login + push -> ECS task definition + rollout -> HEALTH_CHECK
//     -> SUCCESS, or ROLLING_BACK to the stable image digest -> Redis -> SSE
//
// Everything is the real code - webhook verification, queue, processor,
// pipeline, AWS_ECS target, ECR and ECS services, health check, release and
// rollback - except the Docker build (the image appears at once) and AWS
// itself: the SDK clients talk to the fakes in fakeAws.js, whose ECS services
// are HTTP servers that answer as the version they currently run.
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { ECR_PASSWORD, createFakeEcs, createFakeRegistry } from './fakeAws.js';
import { createFakeDocker, fakeImageName } from './fakeDocker.js';
import { WEBHOOK_SECRET, pushPayload, randomSha, sendWebhook } from './githubWebhook.js';
import {
  getDeploymentQueue,
  openLogStream,
  pool,
  projectPayload,
  recordDeploymentEvents,
  setupTestServer,
  waitFor,
} from './helpers.js';

// The worker's AWS settings, and fast rollouts and health checks.
process.env.AWS_REGION = 'eu-west-1';
process.env.AWS_ECR_REPOSITORY = 'deployx-apps';
process.env.AWS_ECS_CLUSTER = 'deployx-cluster';
process.env.AWS_ECS_POLL_INTERVAL_MS = '15';
process.env.AWS_ECS_DEPLOY_TIMEOUT_MS = '800';
// The fake services listen on 127.0.0.1.
process.env.HEALTH_CHECK_ALLOW_PRIVATE_URLS = 'true';
process.env.HEALTH_CHECK_HOST = '127.0.0.1';
process.env.HEALTH_CHECK_STARTUP_GRACE_MS = '0';
process.env.HEALTH_CHECK_INTERVAL_MS = '40';
process.env.HEALTH_CHECK_TIMEOUT_MS = '300';
process.env.HEALTH_CHECK_RETRIES = '3';
process.env.CONTAINER_STARTUP_GRACE_MS = '1';

const FINAL = ['SUCCESS', 'FAILED', 'ROLLBACK_FAILED'];

let api;
let worker;
let closeWorkerPostgres;
let workerConfig;
let projectImageName;
let docker;
let registry;
let ecs;
const builds = [];
let projectCounter = 0;

before(async () => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});

  api = await setupTestServer();
  const { default: serverConfig } = await import('../src/config/index.js');
  serverConfig.github.webhookSecret = WEBHOOK_SECRET;

  // Imported after setupTestServer() so the worker reads the test settings.
  const { createDeploymentWorker } = await import('../../worker/src/worker.js');
  const { createDeploymentProcessor } = await import('../../worker/src/processors/deploymentProcessor.js');
  const { createDeploymentPipeline } = await import('../../worker/src/pipeline/dockerDeployment.js');
  const { createTargets } = await import('../../worker/src/targets/index.js');
  const { createEcrService } = await import('../../worker/src/services/ecrService.js');
  const { createAwsDeploymentService } = await import('../../worker/src/services/awsDeploymentService.js');
  const { recordImage } = await import('../../worker/src/services/deploymentService.js');
  ({ projectImageName } = await import('../../worker/src/services/dockerService.js'));
  ({ default: workerConfig } = await import('../../worker/src/config/index.js'));
  ({ closePostgres: closeWorkerPostgres } = await import('../../worker/src/db/postgres.js'));

  docker = createFakeDocker();
  registry = createFakeRegistry();
  ecs = createFakeEcs({ registry });
  // The Docker CLI as the worker sees it: containers (LOCAL) plus registry login, tag and push.
  const dockerCli = { ...docker, ...registry.docker };

  // Stands in for clone + docker build: the image of the commit exists at once.
  async function fakeBuild(ctx) {
    const { deployment, project } = ctx;
    const image = fakeImageName(project, deployment.commit_sha);
    builds.push({ deploymentId: deployment.id, commit: deployment.commit_sha });
    docker.addImage(image);
    await recordImage(deployment.id, image);
    await ctx.log('INFO', `Docker image created: ${image}`);
    return { image, commitSha: deployment.commit_sha, cleanUp: async () => {} };
  }

  const pipeline = createDeploymentPipeline({
    build: fakeBuild,
    targets: createTargets({
      docker: dockerCli,
      ecr: createEcrService({ client: registry.client, docker: dockerCli }),
      ecs: createAwsDeploymentService({ client: ecs.client }),
    }),
  });
  worker = createDeploymentWorker({ concurrency: 3, processor: createDeploymentProcessor({ pipeline }) });
});

after(async () => {
  await worker.close();
  await docker.removeAll();
  await ecs.close();
  await api.close();
  await closeWorkerPostgres();
  mock.restoreAll();
});

// ---- helpers -----------------------------------------------------------------

// A project deploying to its own (fake) ECS service.
async function awsProject(overrides = {}) {
  projectCounter += 1;
  const number = projectCounter;
  const service = await ecs.addService(`app-${number}`, { containerPort: 3000 });
  const { status, body } = await api.post(
    '/api/projects',
    projectPayload({
      github_repo: `https://github.com/octo-org/aws-app-${number}`,
      deployment_target: 'AWS_ECS',
      aws_ecs_service: service.name,
      aws_service_url: service.url,
      ...overrides,
    }),
  );
  assert.equal(status, 201, JSON.stringify(body));
  return { project: body.data, service };
}

// A version whose app answers `app(path, requestNumber)` (healthy by default).
function version(app) {
  const sha = randomSha();
  if (app) ecs.setApp(sha, app);
  return sha;
}

// git push -> GitHub webhook. Returns the created deployment's ID.
async function push(project, sha, { expect = 202 } = {}) {
  const { status, body } = await sendWebhook(api.baseUrl, { payload: pushPayload({ repo: project.github_repo, sha }) });
  assert.equal(status, expect, JSON.stringify(body));
  return body.data.deployments[0]?.deployment_id;
}

async function getDeployment(id) {
  return (await api.get(`/api/deployments/${id}`)).body.data;
}

async function finished(id) {
  return waitFor(
    async () => {
      const deployment = await getDeployment(id);
      return FINAL.includes(deployment.status) ? deployment : null;
    },
    { timeout: 20000 },
  );
}

async function pushAndWait(project, sha) {
  return finished(await push(project, sha));
}

async function logLines(deploymentId) {
  const { rows } = await pool.query('SELECT level, message FROM deployment_logs WHERE deployment_id = $1 ORDER BY id', [
    deploymentId,
  ]);
  return rows.map(({ level, message }) => `${level} ${message}`);
}

async function row(deploymentId) {
  return (await pool.query('SELECT * FROM deployments WHERE id = $1', [deploymentId])).rows[0];
}

function statusesOf(recorder, deploymentId) {
  return recorder.forDeployment(deploymentId).filter((event) => event.type === 'status').map((event) => event.status);
}

function assertInOrder(lines, expected) {
  let index = 0;
  for (const pattern of expected) {
    const found = lines.findIndex((line, i) => i >= index && pattern.test(line));
    assert.ok(found !== -1, `expected a log line matching ${pattern} after position ${index}:\n${lines.join('\n')}`);
    index = found + 1;
  }
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The ECR tag of a project's commit: <project>-<id-prefix>-<commit-12>.
function commitTag(project, sha) {
  return `${projectImageName(project.name, project.id)}-${sha.slice(0, 12)}`;
}

// The task definitions a service was updated to, as "family:revision".
function updatesOf(serviceName) {
  return ecs.service(serviceName).updates.map((arn) => arn.split('/').pop());
}

// ---- tests -------------------------------------------------------------------

describe('GitHub push to AWS ECS', () => {
  // Shared by the first tests, which build on each other.
  let project;
  let service;
  let stable;

  test('push -> webhook -> BullMQ -> build -> ECR -> ECS -> HEALTH_CHECK -> SUCCESS, and the deployment becomes stable', async () => {
    ({ project, service } = await awsProject());
    const recorder = await recordDeploymentEvents();
    const shaA = version();

    const id = await push(project, shaA);
    const stream = await openLogStream(api.baseUrl, id);
    const deployment = await finished(id);
    await stream.waitFor((event) => event.event === 'end');
    await recorder.close();
    stable = deployment;

    // The record identifies exactly what runs where.
    assert.equal(deployment.status, 'SUCCESS', deployment.error_message);
    assert.equal(deployment.trigger, 'GITHUB_PUSH');
    assert.equal(deployment.deployment_target, 'AWS_ECS');
    assert.equal(deployment.commit_sha, shaA);
    assert.equal(deployment.is_stable, true);
    const tag = commitTag(project, shaA);
    assert.equal(deployment.docker_image, `${registry.uri}:${tag}`);
    assert.equal(deployment.image_digest, registry.digestOfTag(tag));
    assert.match(deployment.aws_task_definition_arn, /^arn:aws:ecs:eu-west-1:123456789012:task-definition\/app-\d+:2$/);
    assert.equal(deployment.container_id, null);
    assert.equal(deployment.health_check.status, 'PASSED');
    assert.equal(deployment.health_check.status_code, 200);

    // ECR holds the image under the commit and deployment tags; ECS runs it by digest.
    assert.equal(registry.digestOfTag(`${projectImageName(project.name, project.id)}-deployment-${id}`), deployment.image_digest);
    assert.equal(ecs.appImage(ecs.service(service.name).running), `${registry.uri}@${deployment.image_digest}`);
    assert.equal(ecs.commitRunning(service.name), shaA);
    assert.deepEqual(ecs.service(service.name).requests.map((request) => request.path), ['/health']);
    // The sidecar and every other setting of the operator's task definition are kept.
    const running = ecs.taskDefinition(ecs.service(service.name).running);
    assert.equal(running.containerDefinitions[0].image, 'public.ecr.aws/aws-observability/aws-for-fluent-bit:stable');
    assert.deepEqual(running.containerDefinitions[1].environment, [{ name: 'NODE_ENV', value: 'production' }]);

    assert.deepEqual(statusesOf(recorder, id), ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS']);

    const lines = await logLines(id);
    assertInOrder(lines, [
      /^INFO GitHub webhook received: push to main \(delivery [0-9a-f-]+\)$/,
      /^INFO Repository identified: octo-org\/aws-app-\d+, deploying branch main$/,
      new RegExp(`^INFO Commit identified: ${shaA} \\(Update the app\\)$`),
      /^INFO Deployment created$/,
      /^INFO Deployment job started \(attempt 1 of 3\)$/,
      /^INFO Deployment is now building$/,
      /^INFO Docker image created: fake\//,
      /^INFO Logging in to Amazon ECR \(repository deployx-apps\)$/,
      /^INFO ECR login succeeded$/,
      new RegExp(`^INFO Pushing image to ECR as ${escape(tag)}$`),
      new RegExp(`^INFO Image pushed to ECR: ${escape(registry.uri)}:${escape(tag)} \\(digest sha256:[0-9a-f]{64}\\)$`),
      /^INFO Deployment is now deploying$/,
      new RegExp(`^INFO AWS deployment started: ECS service ${service.name} in cluster deployx-cluster$`),
      new RegExp(`^INFO Registered task definition ${service.name}:2 \\(container app\\)$`),
      /^INFO ECS deployment ecs-svc\/\d+ started; waiting for the new tasks$/,
      /^INFO AWS deployment progressing: 0\/1 tasks running, 1 pending$/,
      /^INFO ECS rollout completed: 1\/1 tasks running$/,
      new RegExp(`^INFO AWS deployment completed: ECS service ${service.name} runs ${service.name}:2$`),
      new RegExp(`^INFO Running health checks: GET ${escape(service.url)}/health \\(up to 3 attempts, 0\\.3s timeout, 0\\.04s apart\\)$`),
      /^INFO Health check attempt 1\/3 passed: HTTP 200 in \d+ms$/,
      /^INFO Deployment completed successfully$/,
    ]);

    // The same lines reached the browser over the existing SSE stream.
    assert.deepEqual(
      stream.events.filter((event) => event.event === 'log').map((event) => `${event.data.level} ${event.data.message}`),
      lines,
    );
    assert.deepEqual(stream.events.at(-1), { event: 'end', data: { deploymentId: id, status: 'SUCCESS' } });

    // One job in the shared queue, keyed by the deployment; no secrets anywhere.
    const job = await getDeploymentQueue().getJob(id);
    assert.deepEqual(job.data, { deploymentId: id, projectId: project.id, commitSha: shaA, branch: 'main' });
    assert.equal(registry.logins.at(-1).password, ECR_PASSWORD);
    const everything = JSON.stringify(await getDeployment(id)) + lines.join('\n');
    assert.ok(!everything.includes(ECR_PASSWORD));
    assert.ok(!everything.includes(WEBHOOK_SECRET));
  });

  test('an unhealthy push is rolled back to the stable image by digest, without rebuilding it', async () => {
    const shaB = version(() => 500);
    const buildsBefore = builds.length;
    const stableBefore = await row(stable.id);
    const recorder = await recordDeploymentEvents();

    const id = await push(project, shaB);
    const stream = await openLogStream(api.baseUrl, id);
    const b = await finished(id);
    await stream.waitFor((event) => event.event === 'end');
    await recorder.close();

    assert.equal(b.status, 'FAILED');
    assert.equal(b.rollback_status, 'COMPLETED');
    assert.equal(b.rollback_deployment_id, stable.id);
    assert.equal(b.is_stable, false);
    assert.equal(
      b.error_message,
      `Health check failed after 3 attempts: Health check returned HTTP 500. Rolled back to deployment ${stable.id}.`,
    );
    assert.deepEqual(statusesOf(recorder, id), ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK', 'FAILED']);

    // The service runs A again: A's own image digest, deployed as a new revision.
    assert.equal(ecs.commitRunning(service.name), stable.commit_sha);
    assert.deepEqual(updatesOf(service.name), [`${service.name}:2`, `${service.name}:3`, `${service.name}:4`]);
    assert.equal(ecs.appImage(ecs.service(service.name).running), `${registry.uri}@${stable.image_digest}`);
    // Only B was built; A came back from its image.
    assert.deepEqual(builds.slice(buildsBefore).map((build) => build.commit), [shaB]);

    // A is the stable deployment again; only where it runs was updated.
    const a = await getDeployment(stable.id);
    assert.equal(a.status, 'SUCCESS');
    assert.equal(a.is_stable, true);
    assert.match(a.aws_task_definition_arn, new RegExp(`/${service.name}:4$`));
    const { aws_task_definition_arn: before, updated_at: beforeUpdated, ...unchanged } = stableBefore;
    const { aws_task_definition_arn: now, updated_at: nowUpdated, ...stillUnchanged } = await row(stable.id);
    assert.deepEqual(stillUnchanged, unchanged);

    const lines = await logLines(id);
    assertInOrder(lines, [
      new RegExp(`^INFO Running health checks: GET ${escape(service.url)}/health `),
      /^WARN Health check attempt 3\/3 failed: Health check returned HTTP 500$/,
      /^ERROR Health check failed after 3 attempts: Health check returned HTTP 500$/,
      /^ERROR Deployment marked unhealthy$/,
      /^INFO Starting automatic rollback$/,
      new RegExp(`^INFO Previous stable deployment: ${stable.id} \\(commit ${stable.commit_sha.slice(0, 7)}\\)$`),
      new RegExp(`^INFO The unhealthy version is replaced on ECS service ${service.name}$`),
      new RegExp(`^INFO Starting stable version from image ${escape(stable.docker_image)} \\(digest ${stable.image_digest.slice(7, 19)}\\)$`),
      new RegExp(`^INFO Registered task definition ${service.name}:4 \\(container app\\)$`),
      /^INFO ECS rollout completed: 1\/1 tasks running$/,
      new RegExp(`^INFO ECS service ${service.name} runs ${service.name}:4$`),
      /^INFO Running health check on the stable version$/,
      /^INFO Health check attempt 1\/3 passed: HTTP 200 in \d+ms$/,
      /^INFO Stable version is healthy$/,
      new RegExp(`^INFO Rollback completed successfully: deployment ${stable.id} is live$`),
      /^ERROR Deployment failed: the application is unhealthy; the last stable version was restored$/,
    ]);
    assert.ok((await logLines(stable.id)).includes(`INFO Restored as the live version: deployment ${id} failed its health check`));

    // The live stream stayed open through the rollback and ended on FAILED.
    assert.ok(stream.statuses().includes('ROLLING_BACK'));
    assert.deepEqual(
      stream.events.filter((event) => event.event === 'log').map((event) => `${event.data.level} ${event.data.message}`),
      lines,
    );
    assert.deepEqual(stream.events.at(-1), { event: 'end', data: { deploymentId: id, status: 'FAILED' } });

    // History, newest first; a redelivered push changes nothing.
    await push(project, shaB, { expect: 200 });
    const history = (await api.get(`/api/projects/${project.id}/deployments`)).body.data;
    assert.deepEqual(
      history.map(({ id: deploymentId, status, trigger }) => ({ id: deploymentId, status, trigger })),
      [
        { id, status: 'FAILED', trigger: 'GITHUB_PUSH' },
        { id: stable.id, status: 'SUCCESS', trigger: 'GITHUB_PUSH' },
      ],
    );
    // An unhealthy deployment is not rebuilt by BullMQ.
    assert.equal(lines.filter((line) => line.includes('Deployment job started')).length, 1);
  });

  test('a manual deployment of the stable commit uses the same pipeline and replaces nothing but the image', async () => {
    const { status, body } = await api.post(`/api/projects/${project.id}/deployments`, { commit_sha: stable.commit_sha });
    assert.equal(status, 201);
    const again = await finished(body.data.deployment.id);
    assert.equal(again.status, 'SUCCESS', again.error_message);
    assert.equal(again.trigger, 'MANUAL');
    assert.equal(again.deployment_target, 'AWS_ECS');
    // Same commit, same content: the same digest.
    assert.equal(again.image_digest, stable.image_digest);
    assert.equal(again.is_stable, true);
    assert.equal(ecs.commitRunning(service.name), stable.commit_sha);
  });
});

describe('failures on AWS', () => {
  test('an unhealthy first deployment has nothing to roll back to: the service goes back to its previous task definition', async () => {
    const { project, service } = await awsProject();
    const recorder = await recordDeploymentEvents();
    const id = await push(project, version(() => 503));
    const deployment = await finished(id);
    await recorder.close();

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.rollback_status, 'NOT_AVAILABLE');
    assert.equal(
      deployment.error_message,
      'Health check failed after 3 attempts: Health check returned HTTP 503. No previous stable deployment available for rollback.',
    );
    assert.deepEqual(statusesOf(recorder, id), ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'FAILED']);
    assert.equal(ecs.service(service.name).taskDefinition, service.initialTaskDefinition);
    assertInOrder(await logLines(id), [
      /^WARN No previous stable deployment available for rollback\.$/,
      new RegExp(`^INFO Stopping unhealthy version: ECS service ${service.name} goes back to ${service.name}:1$`),
      /^ERROR Deployment failed: the application is unhealthy and there is nothing to roll back to$/,
    ]);
  });

  test('a rollout whose tasks never start is retried, then FAILED, and the service keeps its previous version', async () => {
    const { project, service } = await awsProject();
    const sha = version();
    ecs.failTasks(sha);
    const deployment = await pushAndWait(project, sha);

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.error_message, 'ECS rollout failed: ECS deployment circuit breaker: tasks failed to start.');
    assert.equal(deployment.health_check, null, 'a version that never ran is never health-checked');
    assert.equal(deployment.rollback_status, null);
    assert.equal(ecs.service(service.name).taskDefinition, service.initialTaskDefinition);
    assert.equal(ecs.commitRunning(service.name), null);

    const lines = await logLines(deployment.id);
    assert.equal(lines.filter((line) => line.startsWith('INFO Deployment job started')).length, 3);
    assert.equal(lines.filter((line) => line === `WARN Reverting ECS service ${service.name} to ${service.name}:1`).length, 3);
    assertInOrder(lines, [
      /^WARN AWS deployment progressing: 0\/1 tasks running, 0 pending, 2 failed to start$/,
      /^ERROR Attempt 1 of 3 failed: ECS rollout failed: /,
      /^WARN Retrying in 0\.2s \(attempt 2 of 3\)$/,
      /^ERROR Attempt 3 of 3 failed: /,
      /^ERROR Deployment failed after maximum retry attempts$/,
    ]);
  });

  test('a rollout that does not finish in time fails like any other attempt', async () => {
    const { project, service } = await awsProject();
    const sha = version();
    ecs.stickRollout(sha);
    const deployment = await pushAndWait(project, sha);

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.error_message, 'ECS deployment did not complete within 0.8s (0/1 tasks running, 1 pending)');
    assert.equal(ecs.service(service.name).taskDefinition, service.initialTaskDefinition);
  });

  test('ECR: a failed push is retried; missing permissions fail at once', async () => {
    const { project } = await awsProject();
    registry.faults.fail('docker push', new Error('Pushing failed: net/http: TLS handshake timeout'), { times: 1 });
    const flaky = await pushAndWait(project, version());
    assert.equal(flaky.status, 'SUCCESS', flaky.error_message);
    assert.ok((await logLines(flaky.id)).includes('ERROR Attempt 1 of 3 failed: Pushing failed: net/http: TLS handshake timeout'));

    registry.faults.fail(
      'GetAuthorizationToken',
      Object.assign(new Error('User is not authorized to perform: ecr:GetAuthorizationToken'), { name: 'AccessDeniedException' }),
      { times: 1 },
    );
    const denied = await pushAndWait(project, version());
    assert.equal(denied.status, 'FAILED');
    assert.equal(
      denied.error_message,
      'ECR GetAuthorizationToken failed: AccessDeniedException: User is not authorized to perform: ecr:GetAuthorizationToken',
    );
    const lines = await logLines(denied.id);
    assert.equal(lines.filter((line) => line.startsWith('INFO Deployment job started')).length, 1);
    assert.ok(lines.includes('ERROR Deployment failed and will not be retried'));
    // The previous version is untouched and still stable.
    assert.equal((await getDeployment(flaky.id)).is_stable, true);
  });

  test('the rollback fails when the stable image was deleted from ECR: ROLLBACK_FAILED', async () => {
    const { project } = await awsProject();
    const a = await pushAndWait(project, version());
    assert.equal(a.status, 'SUCCESS', a.error_message);
    const aBefore = await row(a.id);
    registry.deleteImage(a.image_digest);

    const b = await pushAndWait(project, version(() => 500));
    assert.equal(b.status, 'ROLLBACK_FAILED');
    assert.equal(b.rollback_status, 'FAILED');
    assert.equal(b.rollback_deployment_id, a.id);
    assert.match(
      b.error_message,
      new RegExp(`Rollback to deployment ${a.id} failed: image ${escape(a.docker_image)} of the stable deployment is no longer available in ECR$`),
    );
    assert.ok(!(await logLines(b.id)).some((line) => /Rollback completed|Stable version is healthy/.test(line)));
    assert.deepEqual(await row(a.id), aBefore);
  });

  test('the rollback fails when the stable version is unhealthy too: ROLLBACK_FAILED, no false recovery', async () => {
    const { project, service } = await awsProject();
    const shaA = version();
    const a = await pushAndWait(project, shaA);
    ecs.setApp(shaA, () => 502);

    const b = await pushAndWait(project, version(() => 500));
    assert.equal(b.status, 'ROLLBACK_FAILED');
    assert.equal(
      b.error_message,
      'Health check failed after 3 attempts: Health check returned HTTP 500. ' +
        `Rollback to deployment ${a.id} failed: the stable deployment is unhealthy too (Health check returned HTTP 502)`,
    );
    // The stable image was deployed again, but nothing claims it recovered.
    assert.equal(ecs.commitRunning(service.name), shaA);
    assert.ok(!(await logLines(a.id)).some((line) => line.includes('Restored as the live version')));
  });

  test('without AWS settings the worker refuses AWS deployments at once', async () => {
    const { project } = await awsProject();
    const saved = workerConfig.aws.ecrRepository;
    workerConfig.aws.ecrRepository = '';
    try {
      const deployment = await pushAndWait(project, version());
      assert.equal(deployment.status, 'FAILED');
      assert.equal(deployment.error_message, 'AWS deployments are not configured on this worker: set AWS_ECR_REPOSITORY');
      assert.equal((await logLines(deployment.id)).filter((line) => line.includes('Deployment job started')).length, 1);
    } finally {
      workerConfig.aws.ecrRepository = saved;
    }
  });
});

describe('isolation', () => {
  test('projects deploy to their own services at the same time: images, jobs, events and rollbacks never mix', async () => {
    const [one, two, three] = await Promise.all([awsProject(), awsProject(), awsProject()]);
    const shas = [version(), version(), version(() => 500)];
    const recorder = await recordDeploymentEvents();
    const ids = await Promise.all([one, two, three].map(({ project }, index) => push(project, shas[index])));
    const [a, b, c] = await Promise.all(ids.map((id) => finished(id)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await recorder.close();

    assert.equal(a.status, 'SUCCESS', a.error_message);
    assert.equal(b.status, 'SUCCESS', b.error_message);
    assert.equal(c.status, 'FAILED');
    assert.equal(c.rollback_status, 'NOT_AVAILABLE');

    for (const [index, { project, service }] of [one, two, three].entries()) {
      const deployment = [a, b, c][index];
      // Each image is tagged for its own project and commit, and ran only on its own service.
      assert.equal(deployment.docker_image, `${registry.uri}:${commitTag(project, shas[index])}`);
      assert.ok(updatesOf(service.name).every((name) => name.startsWith(`${service.name}:`)));
      assert.ok(
        ecs.service(service.name).updates.every((arn) => {
          const commit = registry.commitOf(ecs.appImage(arn));
          return commit === null || commit === shas[index];
        }),
        `service ${service.name} only ever ran its own project's images`,
      );
      // Its job and its events are its own.
      assert.equal((await getDeploymentQueue().getJob(deployment.id)).data.projectId, project.id);
      const events = recorder.events.filter((entry) => entry.event.deploymentId === deployment.id);
      assert.ok(events.length > 5);
      assert.ok(events.every((entry) => entry.channel === `${process.env.QUEUE_PREFIX}:deployment:${deployment.id}:events`));
      const others = [one, two, three].filter((_, other) => other !== index).map((entry) => entry.service.name);
      assert.ok(!(await logLines(deployment.id)).some((line) => others.some((name) => line.includes(`service ${name} `))));
    }
    assert.equal(ecs.commitRunning(one.service.name), shas[0]);
    assert.equal(ecs.commitRunning(two.service.name), shas[1]);
    // The unhealthy first version was taken out of service: ECS rolls back to
    // the operator's task definition on its own (DeployX does not wait for it).
    assert.equal(ecs.service(three.service.name).taskDefinition, three.service.initialTaskDefinition);
  });

  test('two pushes to one project are deployed one after the other; the service ends on the stable one', async () => {
    const { project, service } = await awsProject();
    const [first, second] = await Promise.all([pushAndWait(project, version()), pushAndWait(project, version())]);
    assert.equal(first.status, 'SUCCESS', first.error_message);
    assert.equal(second.status, 'SUCCESS', second.error_message);

    const { rows } = await pool.query('SELECT stable_deployment_id($1) AS id', [project.id]);
    const stableOne = rows[0].id === first.id ? first : second;
    assert.equal(ecs.commitRunning(service.name), stableOne.commit_sha);
    // The rollouts did not overlap: every one of them completed.
    assert.equal(updatesOf(service.name).length, 2);
    assert.ok(![first, second].some((deployment) => /replaced by another deployment/.test(deployment.error_message ?? '')));
  });

  test('switching a project from LOCAL to AWS: no cross-target rollback, and the local container is retired', async () => {
    const { project, service } = await awsProject();
    await api.put(`/api/projects/${project.id}`, { deployment_target: 'LOCAL' });
    const local = (await api.post(`/api/projects/${project.id}/deployments`, { commit_sha: version() })).body.data.deployment;
    const localDone = await finished(local.id);
    assert.equal(localDone.status, 'SUCCESS', localDone.error_message);
    assert.equal(localDone.deployment_target, 'LOCAL');
    assert.equal((await docker.listProjectContainers(project.id)).length, 1);

    await api.put(`/api/projects/${project.id}`, { deployment_target: 'AWS_ECS' });
    const unhealthy = await pushAndWait(project, version(() => 500));
    assert.equal(unhealthy.status, 'FAILED');
    assert.equal(unhealthy.rollback_status, 'NOT_AVAILABLE');
    assert.match(
      unhealthy.error_message,
      /No previous stable deployment on AWS_ECS available for rollback \(the last stable deployment ran on LOCAL\)\.$/,
    );
    // The local version was not touched by the failed AWS deployment.
    assert.equal((await docker.listProjectContainers(project.id)).length, 1);

    const aws = await pushAndWait(project, version());
    assert.equal(aws.status, 'SUCCESS', aws.error_message);
    assert.equal(aws.is_stable, true);
    await waitFor(async () => (await docker.listProjectContainers(project.id)).length === 0);
    assert.ok((await getDeployment(local.id)).container_removed_at);
    assert.equal(ecs.commitRunning(service.name), aws.commit_sha);
  });
});
