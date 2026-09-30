// End-to-end tests of the real Docker deployment pipeline:
//   API -> BullMQ -> worker -> git clone (GitHub) -> docker build -> docker run
//       -> HTTP health check -> SUCCESS, or automatic rollback
//
// They need network access (github.com, Docker Hub) and a running Docker
// daemon, so they only run when DEPLOYX_DOCKER_TESTS=1:
//   npm run test:docker        (from server/, or `npm run test:docker` at the root)
// The test repository is this project itself (examples/ on GitHub, on the
// branch DEPLOYX_TEST_BRANCH, main by default).
// Everything they create uses its own image prefix and network and is
// removed afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { projectPayload, setupTestServer, pool } from './helpers.js';

const ENABLED = process.env.DEPLOYX_DOCKER_TESTS === '1';
const TEST_REPO = 'https://github.com/devtejasx/DeployX';
const TEST_BRANCH = process.env.DEPLOYX_TEST_BRANCH || 'main';
// The commit that added examples/; deployed by SHA to test checkout. Its
// hello-app has no /health endpoint yet (GET / answers 200).
const EXAMPLES_COMMIT = 'd577dab';
const IMAGE_PREFIX = 'deployx-test';
const APP_NETWORK = 'deployx-apps-test';

let api;
let worker;
let runCommand;
let closeWorkerPostgres;
let workspaceRoot;
// Shared by the rollback tests (9-11), which build on each other.
let rollbackProject;
let stableDeployment;
const projectIds = [];

async function docker(args) {
  return runCommand('docker', args, { timeoutMs: 120000 });
}

async function waitFor(check, { timeout = 180000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function createProject(overrides) {
  const { status, body } = await api.post(
    '/api/projects',
    projectPayload({ github_repo: TEST_REPO, github_branch: TEST_BRANCH, container_port: 3000, ...overrides }),
  );
  assert.equal(status, 201);
  projectIds.push(body.data.id);
  return body.data;
}

async function deployAndWait(project, body = {}) {
  const { status, body: created } = await api.post(`/api/projects/${project.id}/deployments`, body);
  assert.equal(status, 201);
  const { id } = created.data.deployment;
  return waitFor(async () => {
    const { body: current } = await api.get(`/api/deployments/${id}`);
    return ['SUCCESS', 'FAILED'].includes(current.data.status) ? current.data : null;
  });
}

async function logMessages(deploymentId) {
  const { body } = await api.get(`/api/deployments/${deploymentId}/logs`);
  return body.data.map((line) => line.message);
}

// IDs of the project's containers that are currently running.
async function runningContainers(project) {
  const { stdout } = await docker(['ps', '-q', '--no-trunc', '--filter', `label=deployx.project=${project.id}`]);
  return stdout.split(/\s+/).filter(Boolean);
}

// The immutable ID of the image the deployment was built as.
async function imageIdOf(deployment) {
  const { rows } = await pool.query('SELECT docker_image_id FROM deployments WHERE id = $1', [deployment.id]);
  return rows[0].docker_image_id;
}

// Points the project at another example app for its next deployments.
async function usesDockerfile(project, dockerfilePath) {
  const { status } = await api.put(`/api/projects/${project.id}`, { dockerfile_path: dockerfilePath });
  assert.equal(status, 200);
}

function attempts(messages) {
  return messages.filter((message) => message.startsWith('Deployment job started')).length;
}

// Asserts that `expected` patterns appear in `messages` in this order.
function assertInOrder(messages, expected) {
  let index = 0;
  for (const pattern of expected) {
    const found = messages.findIndex((message, i) => i >= index && pattern.test(message));
    assert.ok(found !== -1, `expected a log line matching ${pattern} after position ${index}:\n${messages.join('\n')}`);
    index = found + 1;
  }
}

describe('Docker deployment pipeline', { skip: !ENABLED && 'set DEPLOYX_DOCKER_TESTS=1 (needs Docker + network)' }, () => {
  before(async () => {
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployx-e2e-'));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.DOCKER_IMAGE_PREFIX = IMAGE_PREFIX;
    process.env.DEPLOYX_APP_NETWORK = APP_NETWORK;
    process.env.CONTAINER_STARTUP_GRACE_MS = '2000';
    // Health checks: 1s for the app to start, then up to 4 attempts 0.5s apart.
    process.env.HEALTH_CHECK_HOST = '127.0.0.1';
    process.env.HEALTH_CHECK_TIMEOUT_MS = '2000';
    process.env.HEALTH_CHECK_STARTUP_GRACE_MS = '1000';
    process.env.HEALTH_CHECK_INTERVAL_MS = '500';
    process.env.HEALTH_CHECK_RETRIES = '4';

    api = await setupTestServer();
    ({ runCommand } = await import('../../worker/src/lib/exec.js'));
    const { createDeploymentWorker } = await import('../../worker/src/worker.js');
    ({ closePostgres: closeWorkerPostgres } = await import('../../worker/src/db/postgres.js'));
    worker = createDeploymentWorker({ concurrency: 2 });
  });

  after(async () => {
    await worker?.close();
    for (const projectId of projectIds) {
      const { stdout } = await docker(['ps', '-aq', '--filter', `label=deployx.project=${projectId}`]);
      for (const id of stdout.split(/\s+/).filter(Boolean)) await docker(['rm', '-f', id]);
    }
    const images = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${IMAGE_PREFIX}/*`]);
    for (const image of images.stdout.split(/\s+/).filter(Boolean)) await docker(['rmi', '-f', image]);
    await docker(['network', 'rm', APP_NETWORK]);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await api?.close();
    await closeWorkerPostgres?.();
    mock.restoreAll();
  });

  test('Test 1: clones a specific commit, builds, starts the container, checks its health and serves traffic', async () => {
    // This commit's hello-app has no /health yet, so the project checks "/".
    const project = await createProject({
      name: 'Hello App',
      dockerfile_path: 'examples/hello-app/Dockerfile',
      health_check_path: '/',
    });
    const deployment = await deployAndWait(project, { commit_sha: EXAMPLES_COMMIT });

    assert.equal(deployment.status, 'SUCCESS', deployment.error_message);
    assert.match(deployment.commit_sha, /^d577dab[0-9a-f]{33}$/);
    assert.equal(deployment.docker_image, `${IMAGE_PREFIX}/hello-app-${project.id.slice(0, 8)}:${deployment.commit_sha.slice(0, 12)}`);
    assert.equal(deployment.container_name, `deployx-${project.id}-${deployment.id}`);
    assert.match(deployment.container_id, /^[0-9a-f]{64}$/);
    assert.ok(deployment.host_port > 0);
    assert.equal(deployment.error_message, null);
    assert.equal(deployment.is_stable, true);
    assert.equal(deployment.rollback_status, null);
    assert.ok(deployment.started_at && deployment.finished_at);

    const response = await fetch(`http://127.0.0.1:${deployment.host_port}/`);
    assert.equal(await response.text(), 'Hello from DeployX\n');

    const messages = await logMessages(deployment.id);
    assertInOrder(messages, [
      /^Deployment job started \(attempt 1 of 3\)$/,
      /^Deployment is now building$/,
      /^Cloning repository https:\/\/github\.com\/devtejasx\/DeployX \(branch .+\)$/,
      /^Checking out commit d577dab[0-9a-f]{33}$/,
      /^Dockerfile found at examples\/hello-app\/Dockerfile$/,
      /^Starting Docker build of /,
      /^#\d+ \[\d\/\d\] /,
      /^Docker image created: /,
      /^Deployment is now deploying$/,
      /^Starting container deployx-/,
      /^Container started: .* published on 127\.0\.0\.1:\d+$/,
      /^Cleanup completed: workspace removed$/,
      /^Running health checks: GET http:\/\/127\.0\.0\.1:\d+\/ \(up to 4 attempts, 2s timeout, 0\.5s apart\)$/,
      /^Waiting 1s for the application to start$/,
      /^Health check attempt 1\/4 passed: HTTP 200 in \d+ms$/,
      /^Deployment completed successfully$/,
    ]);
    assert.ok(messages.length < 60, `too many log lines stored: ${messages.length}`);

    // The workspace is gone.
    assert.deepEqual(await fs.readdir(workspaceRoot), []);
  });

  test('Security: the app container is unprivileged, isolated and gets no DeployX secrets', async () => {
    const { rows } = await pool.query(
      `SELECT container_id FROM deployments WHERE status = 'SUCCESS' AND container_removed_at IS NULL LIMIT 1`,
    );
    const { stdout } = await docker(['container', 'inspect', rows[0].container_id]);
    const [info] = JSON.parse(stdout);

    assert.equal(info.HostConfig.Privileged, false);
    assert.deepEqual(info.Mounts, []);
    assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
    assert.ok(!info.HostConfig.CapAdd.some((cap) => /SYS_ADMIN|NET_RAW|NET_ADMIN|SYS_PTRACE/.test(cap)));
    assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.ok(info.HostConfig.Memory > 0 && info.HostConfig.PidsLimit > 0);
    assert.deepEqual(Object.keys(info.NetworkSettings.Networks), [APP_NETWORK]);
    for (const bindings of Object.values(info.NetworkSettings.Ports)) {
      for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1');
    }
    const env = info.Config.Env.join('\n');
    for (const secret of ['DATABASE_URL', 'REDIS_URL', 'REDIS_PASSWORD', 'POSTGRES_PASSWORD', 'DOCKER_HOST']) {
      assert.ok(!env.includes(secret), `${secret} leaked into the app container`);
    }

    // The app network cannot resolve DeployX's own services.
    const probe = await docker([
      'run', '--rm', '--network', APP_NETWORK, 'node:22-alpine', 'node', '-e',
      'require("dns").lookup("postgres",(e)=>console.log(e?"unresolvable":"resolved"))',
    ]);
    assert.equal(probe.stdout.trim(), 'unresolvable');
  });

  test('Test 2 + Test 6: an invalid Dockerfile fails the build, is retried 3 times, then FAILED', async () => {
    const project = await createProject({ name: 'Broken', dockerfile_path: 'examples/broken-dockerfile/Dockerfile' });
    const deployment = await deployAndWait(project);

    assert.equal(deployment.status, 'FAILED');
    assert.match(deployment.error_message, /^Docker build failed: .*unknown instruction: THIS_IS_NOT_A_DOCKERFILE_INSTRUCTION/);
    assert.equal(deployment.container_id, null);
    assert.ok(deployment.finished_at);

    const messages = await logMessages(deployment.id);
    assert.equal(attempts(messages), 3);
    assertInOrder(messages, [
      /^Attempt 1 of 3 failed: Docker build failed/,
      /^Retrying in 0\.2s \(attempt 2 of 3\)$/,
      /^Attempt 2 of 3 failed: Docker build failed/,
      /^Retrying in 0\.4s \(attempt 3 of 3\)$/,
      /^Attempt 3 of 3 failed: Docker build failed/,
      /^Deployment failed after maximum retry attempts$/,
    ]);
    assert.ok(messages.some((message) => message.includes('THIS_IS_NOT_A_DOCKERFILE_INSTRUCTION')));
  });

  test('Test 3: a missing Dockerfile fails without building or retrying', async () => {
    const project = await createProject({ name: 'Missing Dockerfile', dockerfile_path: 'examples/does-not-exist/Dockerfile' });
    const deployment = await deployAndWait(project);

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.error_message, 'Dockerfile not found at examples/does-not-exist/Dockerfile');
    const messages = await logMessages(deployment.id);
    assert.equal(attempts(messages), 1);
    assert.ok(!messages.some((message) => message.startsWith('Starting Docker build')));
    assert.ok(messages.includes('Deployment failed and will not be retried'));
  });

  test('Test 4: a commit that does not exist on the branch fails at checkout', async () => {
    const project = await createProject({ name: 'Bad Commit', dockerfile_path: 'examples/hello-app/Dockerfile' });
    const deployment = await deployAndWait(project, { commit_sha: '0123456789abcdef0123' });

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.error_message, `Commit 0123456789abcdef0123 not found on branch ${TEST_BRANCH}`);
    assert.equal(attempts(await logMessages(deployment.id)), 1);
  });

  test('Test 5: a container that exits immediately fails the deployment and is removed', async () => {
    const project = await createProject({ name: 'Crash App', dockerfile_path: 'examples/crash-app/Dockerfile' });
    const deployment = await deployAndWait(project);

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.error_message, 'Container exited immediately (exit code 1)');
    assert.equal(deployment.container_id, null);
    assert.match(deployment.docker_image, /^deployx-test\/crash-app-/); // the image itself built fine

    const messages = await logMessages(deployment.id);
    assert.equal(attempts(messages), 3);
    assert.ok(messages.includes('[container] crash-app: exiting on purpose'));

    const { stdout } = await docker(['ps', '-aq', '--filter', `label=deployx.deployment=${deployment.id}`]);
    assert.equal(stdout.trim(), '', 'failed container must be removed');
  });

  test('Test 7: several deployments are processed; the newest replaces the running container', async () => {
    const project = await createProject({ name: 'Multi', dockerfile_path: 'examples/hello-app/Dockerfile' });
    // No commit SHA: the branch head is built and its exact SHA recorded.
    const first = await deployAndWait(project);
    assert.equal(first.status, 'SUCCESS', first.error_message);
    assert.match(first.commit_sha, /^[0-9a-f]{40}$/);

    const [second, third] = await Promise.all([deployAndWait(project), deployAndWait(project)]);
    assert.equal(second.status, 'SUCCESS', second.error_message);
    assert.equal(third.status, 'SUCCESS', third.error_message);

    // Exactly one container of the project is left running (the previous ones
    // are retired right after the new deployment became SUCCESS)...
    await waitFor(async () => (await runningContainers(project)).length === 1, { timeout: 30000 });

    // ...it belongs to the stable deployment, and the history is kept: every
    // deployment row still exists, and the replaced ones record when their
    // container was removed.
    const { body } = await api.get(`/api/projects/${project.id}/deployments`);
    assert.equal(body.data.length, 3);
    const live = body.data.filter((d) => d.container_removed_at === null);
    assert.equal(live.length, 1);
    assert.equal(live[0].is_stable, true);
    assert.deepEqual(await runningContainers(project), [live[0].container_id]);
    const { body: firstNow } = await api.get(`/api/deployments/${first.id}`);
    assert.ok(firstNow.data.container_removed_at);
    assert.equal(firstNow.data.is_stable, false);
    assert.ok((await logMessages(first.id)).some((m) => m.startsWith('Container removed: replaced by deployment')));
  });

  test('Test 8: a first deployment that runs but fails its health check is FAILED, with nothing to roll back to', async () => {
    const project = await createProject({ name: 'Unhealthy', dockerfile_path: 'examples/unhealthy-app/Dockerfile' });
    const deployment = await deployAndWait(project);

    assert.equal(deployment.status, 'FAILED');
    assert.equal(deployment.rollback_status, 'NOT_AVAILABLE');
    assert.equal(deployment.rollback_deployment_id, null);
    assert.equal(
      deployment.error_message,
      'Health check failed after 4 attempts: Health check returned HTTP 503. ' +
        'No previous stable deployment available for rollback.',
    );
    assert.match(deployment.docker_image, /^deployx-test\/unhealthy-/); // the image built and the container ran
    assert.ok(deployment.container_removed_at);

    const messages = await logMessages(deployment.id);
    // The application itself is not retried by rebuilding it.
    assert.equal(attempts(messages), 1);
    assertInOrder(messages, [
      /^Container started: /,
      /^Running health checks: GET http:\/\/127\.0\.0\.1:\d+\/health /,
      /^Health check attempt 1\/4 failed: Health check returned HTTP 503$/,
      /^Health check attempt 4\/4 failed: Health check returned HTTP 503$/,
      /^Health check failed after 4 attempts: Health check returned HTTP 503$/,
      /^\[container\] unhealthy-app listening on port 3000/,
      /^Deployment marked unhealthy$/,
      /^No previous stable deployment available for rollback\.$/,
      /^Stopping unhealthy container deployx-/,
      /^Deployment failed: the application is unhealthy and there is nothing to roll back to$/,
    ]);
    assert.ok(!messages.includes('Starting automatic rollback'));
    assert.deepEqual(await runningContainers(project), []);
  });

  test('Test 9: an unhealthy version is rolled back to the stable one, which keeps serving', async () => {
    rollbackProject = await createProject({ name: 'Rollback', dockerfile_path: 'examples/hello-app/Dockerfile' });

    // Version A: hello-app, healthy on the default /health path.
    stableDeployment = await deployAndWait(rollbackProject);
    assert.equal(stableDeployment.status, 'SUCCESS', stableDeployment.error_message);
    assert.equal(stableDeployment.is_stable, true);

    // Version B: the project now builds unhealthy-app (GET /health -> 503).
    await usesDockerfile(rollbackProject, 'examples/unhealthy-app/Dockerfile');
    const failed = await deployAndWait(rollbackProject);

    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.rollback_status, 'COMPLETED');
    assert.equal(failed.rollback_deployment_id, stableDeployment.id);
    assert.equal(
      failed.error_message,
      'Health check failed after 4 attempts: Health check returned HTTP 503. ' +
        `Rolled back to deployment ${stableDeployment.id}.`,
    );
    assert.ok(failed.container_removed_at);

    // Version A never stopped: same container, still answering.
    const { body: stableNow } = await api.get(`/api/deployments/${stableDeployment.id}`);
    assert.equal(stableNow.data.status, 'SUCCESS');
    assert.equal(stableNow.data.is_stable, true);
    assert.equal(stableNow.data.container_id, stableDeployment.container_id);
    assert.deepEqual(await runningContainers(rollbackProject), [stableDeployment.container_id]);
    const response = await fetch(`http://127.0.0.1:${stableNow.data.host_port}/`);
    assert.equal(await response.text(), 'Hello from DeployX\n');

    assertInOrder(await logMessages(failed.id), [
      /^Health check failed after 4 attempts: Health check returned HTTP 503$/,
      /^Deployment marked unhealthy$/,
      /^Starting automatic rollback$/,
      new RegExp(`^Previous stable deployment: ${stableDeployment.id} \\(commit [0-9a-f]{7}\\)$`),
      /^Stopping unhealthy container deployx-/,
      /^Stable container deployx-.* is still running$/,
      /^Running health check on the stable version$/,
      /^Health check attempt 1\/4 passed: HTTP 200 in \d+ms$/,
      /^Stable version is healthy$/,
      /^Rollback completed successfully: deployment /,
      /^Deployment failed: the application is unhealthy; the last stable version was restored$/,
    ]);
    const { body: history } = await api.get(`/api/projects/${rollbackProject.id}/deployments`);
    assert.deepEqual(history.data.map((d) => d.status), ['FAILED', 'SUCCESS']);
  });

  test('Test 10: the stable version is started again from its image when its container is gone', async () => {
    await docker(['rm', '-f', stableDeployment.container_id]);
    assert.deepEqual(await runningContainers(rollbackProject), []);

    const failed = await deployAndWait(rollbackProject);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.rollback_status, 'COMPLETED');
    assert.equal(failed.rollback_deployment_id, stableDeployment.id);

    const { body: restored } = await api.get(`/api/deployments/${stableDeployment.id}`);
    assert.equal(restored.data.status, 'SUCCESS');
    assert.notEqual(restored.data.container_id, stableDeployment.container_id);
    assert.equal(restored.data.docker_image, stableDeployment.docker_image);
    assert.equal(restored.data.container_removed_at, null);
    assert.deepEqual(await runningContainers(rollbackProject), [restored.data.container_id]);
    const response = await fetch(`http://127.0.0.1:${restored.data.host_port}/`);
    assert.equal(await response.text(), 'Hello from DeployX\n');

    // Both versions were built from the same commit, so the commit tag now
    // points at the unhealthy image. The rollback still started the image the
    // stable deployment was built as: it is restored by image ID.
    const stableImageId = await imageIdOf(stableDeployment);
    assert.match(stableImageId, /^sha256:[0-9a-f]{64}$/);
    const tagNow = await docker(['image', 'inspect', '--format', '{{.Id}}', stableDeployment.docker_image]);
    assert.notEqual(tagNow.stdout.trim(), stableImageId);
    const container = await docker(['container', 'inspect', '--format', '{{.Image}}', restored.data.container_id]);
    assert.equal(container.stdout.trim(), stableImageId);

    assertInOrder(await logMessages(failed.id), [
      /^Starting automatic rollback$/,
      new RegExp(`^Starting stable version from image ${stableDeployment.docker_image} \\(ID ${stableImageId.slice(7, 19)}\\)$`),
      /^Running health check on the stable version$/,
      /^Health check attempt \d\/4 passed: HTTP 200 in \d+ms$/,
      /^Rollback completed successfully: deployment /,
    ]);
    stableDeployment = restored.data;
  });

  test('Test 11: the rollback fails, and is reported as failed, when the stable image is gone too', async () => {
    await docker(['rm', '-f', stableDeployment.container_id]);
    await docker(['rmi', '-f', await imageIdOf(stableDeployment)]);

    const failed = await deployAndWait(rollbackProject);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.rollback_status, 'FAILED');
    assert.equal(failed.rollback_deployment_id, stableDeployment.id);
    assert.ok(
      failed.error_message.endsWith(
        `Rollback to deployment ${stableDeployment.id} failed: image ${stableDeployment.docker_image} ` +
          'of the stable deployment is no longer available',
      ),
      failed.error_message,
    );
    const messages = await logMessages(failed.id);
    assert.ok(messages.some((message) => message.startsWith('Rollback failed: image ')));
    assert.ok(!messages.some((message) => message.startsWith('Rollback completed')));
    assert.deepEqual(await runningContainers(rollbackProject), []);

    // Nothing was rewritten: all four deployments are still in the history.
    const { body: history } = await api.get(`/api/projects/${rollbackProject.id}/deployments`);
    assert.deepEqual(history.data.map((d) => d.status), ['FAILED', 'FAILED', 'FAILED', 'SUCCESS']);
  });
});
