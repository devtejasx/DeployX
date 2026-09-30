// Health checks, stable deployments and automatic rollback, end to end:
//   API -> BullMQ -> worker -> health check -> SUCCESS | rollback -> PostgreSQL -> Redis -> SSE
//
// The worker's real processor and release stage (health check, promotion,
// rollback) run here. Only Docker is replaced (fakeDocker.js): each
// "container" is an HTTP server in this process, and its version (the
// deployment's commit SHA) decides how it answers. The same flow against real
// Docker is covered by docker-deploy.test.js.
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { createFakeDeployPipeline, createFakeDocker, fakeImageName } from './fakeDocker.js';
import {
  getDeploymentQueue,
  openLogStream,
  pool,
  projectPayload,
  recordDeploymentEvents,
  setupTestServer,
  waitFor,
} from './helpers.js';

// Fast health checks: no startup wait, 3 attempts 40ms apart, 300ms timeout.
process.env.HEALTH_CHECK_HOST = '127.0.0.1';
process.env.HEALTH_CHECK_STARTUP_GRACE_MS = '0';
process.env.HEALTH_CHECK_INTERVAL_MS = '40';
process.env.HEALTH_CHECK_TIMEOUT_MS = '300';
process.env.HEALTH_CHECK_RETRIES = '3';
process.env.CONTAINER_STARTUP_GRACE_MS = '1';

const NO_STABLE = 'No previous stable deployment available for rollback.';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let api;
let docker;
let worker;
let closeWorkerPostgres;
let commitCounter = 0;

before(async () => {
  // Worker output is expected and noisy (including deliberate failures).
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});

  api = await setupTestServer();
  // Imported after setupTestServer() so the worker reads the test settings.
  const { createDeploymentWorker } = await import('../../worker/src/worker.js');
  const { createDeploymentProcessor } = await import('../../worker/src/processors/deploymentProcessor.js');
  ({ closePostgres: closeWorkerPostgres } = await import('../../worker/src/db/postgres.js'));

  docker = createFakeDocker();
  worker = createDeploymentWorker({
    concurrency: 2,
    processor: createDeploymentProcessor({ pipeline: await createFakeDeployPipeline({ docker }) }),
  });
});

after(async () => {
  await worker.close();
  await docker.removeAll();
  await api.close();
  await closeWorkerPostgres();
  mock.restoreAll();
});

// A new version (commit SHA) whose app answers with `app(path, requestNumber)`.
function version(app) {
  commitCounter += 1;
  const commit = `c0ffee${String(commitCounter).padStart(4, '0')}`;
  if (app) docker.setApp(commit, app);
  return commit;
}
const healthy = () => version();
const unhealthy = (status = 500) => version(() => status);

async function createProject(overrides) {
  const { status, body } = await api.post('/api/projects', projectPayload(overrides));
  assert.equal(status, 201);
  return body.data;
}

async function deploy(project, commit) {
  const { status, body } = await api.post(`/api/projects/${project.id}/deployments`, { commit_sha: commit });
  assert.equal(status, 201);
  return body.data.deployment;
}

async function getDeployment(id) {
  return (await api.get(`/api/deployments/${id}`)).body.data;
}

async function finished(deployment) {
  return waitFor(
    async () => {
      const current = await getDeployment(deployment.id);
      return ['SUCCESS', 'FAILED'].includes(current.status) ? current : null;
    },
    { timeout: 15000 },
  );
}

async function deployAndWait(project, commit) {
  return finished(await deploy(project, commit));
}

async function logLines(deploymentId) {
  const { rows } = await pool.query(
    'SELECT level, message FROM deployment_logs WHERE deployment_id = $1 ORDER BY id',
    [deploymentId],
  );
  return rows.map(({ level, message }) => `${level} ${message}`);
}

async function row(deploymentId) {
  const { rows } = await pool.query('SELECT * FROM deployments WHERE id = $1', [deploymentId]);
  return rows[0];
}

async function history(project) {
  return (await api.get(`/api/projects/${project.id}/deployments`)).body.data;
}

// The project's containers that exist in (fake) Docker, as deployment IDs.
async function liveDeployments(project) {
  return (await docker.listProjectContainers(project.id)).map((container) => container.deploymentId).sort();
}

// What the deployment's published port answers on the project's health path.
async function probe(deployment, path = '/health') {
  const response = await fetch(`http://127.0.0.1:${deployment.host_port}${path}`);
  return { status: response.status, body: (await response.text()).trim() };
}

// Asserts that `expected` patterns appear in `lines` in this order.
function assertInOrder(lines, expected) {
  let index = 0;
  for (const pattern of expected) {
    const found = lines.findIndex((line, i) => i >= index && pattern.test(line));
    assert.ok(found !== -1, `expected a log line matching ${pattern} after position ${index}:\n${lines.join('\n')}`);
    index = found + 1;
  }
}

describe('health check before SUCCESS', () => {
  test('a healthy deployment goes through HEALTH_CHECK and becomes the stable deployment', async () => {
    const recorder = await recordDeploymentEvents();
    try {
      const project = await createProject();
      const deployment = await deployAndWait(project, healthy());
      await sleep(150);

      assert.equal(deployment.status, 'SUCCESS', deployment.error_message);
      assert.equal(deployment.is_stable, true);
      assert.equal(deployment.rollback_status, null);
      assert.equal(deployment.error_message, null);
      assert.ok(deployment.finished_at);

      const statuses = recorder.forDeployment(deployment.id).filter((e) => e.type === 'status').map((e) => e.status);
      assert.deepEqual(statuses, ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS']);

      const container = docker.container(deployment.container_id);
      assert.deepEqual(container.requests, ['/health']);
      assertInOrder(await logLines(deployment.id), [
        /^INFO Container started: /,
        new RegExp(
          `^INFO Running health checks: GET http://127\\.0\\.0\\.1:${container.hostPort}/health ` +
            '\\(up to 3 attempts, 0\\.3s timeout, 0\\.04s apart\\)$',
        ),
        /^INFO Health check attempt 1\/3 passed: HTTP 200 in \d+ms$/,
        /^INFO Deployment completed successfully$/,
      ]);
    } finally {
      await recorder.close();
    }
  });

  test('SUCCESS is never reported before the health check passes (two failed attempts, then healthy)', async () => {
    const recorder = await recordDeploymentEvents();
    try {
      const project = await createProject();
      // Still starting up for the first two requests.
      const slowStart = version((path, requestNumber) => (requestNumber < 3 ? 503 : 200));
      const deployment = await deployAndWait(project, slowStart);
      await sleep(150);

      assert.equal(deployment.status, 'SUCCESS', deployment.error_message);
      assertInOrder(await logLines(deployment.id), [
        /^WARN Health check attempt 1\/3 failed: Health check returned HTTP 503$/,
        /^WARN Health check attempt 2\/3 failed: Health check returned HTTP 503$/,
        /^INFO Health check attempt 3\/3 passed: HTTP 200 in \d+ms$/,
        /^INFO Deployment completed successfully$/,
      ]);

      // In the published event order, SUCCESS comes after the passing attempt
      // and nothing reported it earlier.
      const events = recorder.forDeployment(deployment.id);
      const passed = events.findIndex((e) => e.type === 'log' && e.log.message.includes('attempt 3/3 passed'));
      const success = events.findIndex((e) => e.type === 'status' && e.status === 'SUCCESS');
      assert.ok(passed !== -1 && success > passed);
      assert.equal(events.filter((e) => e.type === 'status' && e.status === 'SUCCESS').length, 1);
      assert.deepEqual(
        events.filter((e) => e.type === 'status').map((e) => e.status),
        ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS'],
      );
    } finally {
      await recorder.close();
    }
  });

  test("the project's own health-check path is requested", async () => {
    const project = await createProject({ health_check_path: '/ready?full=1' });
    const onlyReady = version((path) => (path === '/ready?full=1' ? 200 : 404));
    const deployment = await deployAndWait(project, onlyReady);

    assert.equal(deployment.status, 'SUCCESS', deployment.error_message);
    assert.deepEqual(docker.container(deployment.container_id).requests, ['/ready?full=1']);

    // The same app is unhealthy for a project that checks the default /health.
    const defaultPath = await createProject();
    const failed = await deployAndWait(defaultPath, onlyReady);
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error_message, /^Health check failed after 3 attempts: Health check returned HTTP 404\./);
  });
});

describe('automatic rollback', () => {
  test('an unhealthy deployment is rolled back to the last stable deployment', async () => {
    const project = await createProject();

    // 1-3. Version A is deployed, passes its health check and becomes stable.
    const a = await deployAndWait(project, healthy());
    assert.equal(a.status, 'SUCCESS', a.error_message);
    assert.equal(a.is_stable, true);
    const aBefore = await row(a.id);

    // 4-6. Version B starts, but fails its health check.
    const recorder = await recordDeploymentEvents();
    const commitB = unhealthy(500);
    // The stable version answers a little slowly, so the ROLLING_BACK status
    // lasts long enough for the live stream to show it.
    docker.setApp(a.commit_sha, async () => {
      await sleep(150);
      return 200;
    });
    const queued = await deploy(project, commitB);
    const stream = await openLogStream(api.baseUrl, queued.id);
    const b = await finished(queued);
    await stream.waitFor((e) => e.event === 'end');
    await sleep(100);
    await recorder.close();

    // 7-11. DeployX detected it, found A, verified A and finished the rollback.
    assert.equal(b.status, 'FAILED');
    assert.equal(b.rollback_status, 'COMPLETED');
    assert.equal(b.rollback_deployment_id, a.id);
    assert.equal(b.is_stable, false);
    assert.equal(
      b.error_message,
      `Health check failed after 3 attempts: Health check returned HTTP 500. Rolled back to deployment ${a.id}.`,
    );
    assert.ok(b.finished_at);
    assert.ok(b.container_removed_at, 'the unhealthy container is recorded as removed');
    assert.equal(docker.container(b.container_id), null);

    // Version A is the live, stable version again, and answers.
    assert.deepEqual(await liveDeployments(project), [a.id]);
    assert.deepEqual(await probe(a), { status: 200, body: fakeImageName(project, a.commit_sha) });
    const aAfter = await getDeployment(a.id);
    assert.equal(aAfter.status, 'SUCCESS');
    assert.equal(aAfter.is_stable, true);
    assert.equal(aAfter.container_removed_at, null);

    // The state machine path, as published in real time.
    const statuses = recorder.forDeployment(b.id).filter((e) => e.type === 'status').map((e) => e.status);
    assert.deepEqual(statuses, ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK', 'FAILED']);

    // 12. The logs tell the whole story, in order.
    const expectedLog = [
      /^INFO Container started: /,
      /^INFO Running health checks: GET http:\/\/127\.0\.0\.1:\d+\/health /,
      /^WARN Health check attempt 1\/3 failed: Health check returned HTTP 500$/,
      /^WARN Health check attempt 2\/3 failed: Health check returned HTTP 500$/,
      /^WARN Health check attempt 3\/3 failed: Health check returned HTTP 500$/,
      /^ERROR Health check failed after 3 attempts: Health check returned HTTP 500$/,
      /^INFO \[container\] fake\/.* listening on port 3000$/,
      /^ERROR Deployment marked unhealthy$/,
      /^INFO Starting automatic rollback$/,
      new RegExp(`^INFO Previous stable deployment: ${a.id} \\(commit ${a.commit_sha.slice(0, 7)}\\)$`),
      /^INFO Stopping unhealthy container deployx-/,
      /^INFO Container removed: the deployment failed its health check$/,
      /^INFO Stable container deployx-.* is still running$/,
      /^INFO Running health check on the stable version$/,
      /^INFO Health check attempt 1\/3 passed: HTTP 200 in \d+ms$/,
      /^INFO Stable version is healthy$/,
      new RegExp(`^INFO Rollback completed successfully: deployment ${a.id} is live$`),
      /^ERROR Deployment failed: the application is unhealthy; the last stable version was restored$/,
    ];
    const stored = await logLines(b.id);
    assertInOrder(stored, expectedLog);
    // An unhealthy deployment is not rebuilt: one attempt, no BullMQ retry.
    assert.equal(stored.filter((line) => line.includes('Deployment job started')).length, 1);
    assert.ok(!stored.some((line) => line.includes('Retrying')));
    assert.ok((await logLines(a.id)).includes(`INFO Restored as the live version: deployment ${b.id} failed its health check`));

    // The same lines reached the dashboard through the existing SSE stream,
    // which stayed open through the rollback and ended on FAILED.
    assert.deepEqual(
      stream.events.filter((e) => e.event === 'log').map((e) => `${e.data.level} ${e.data.message}`),
      stored,
    );
    assert.ok(stream.statuses().includes('ROLLING_BACK'), `streamed statuses: ${stream.statuses()}`);
    assert.equal(stream.statuses().at(-1), 'FAILED');
    const finalStatus = stream.events.findLast((e) => e.event === 'status').data;
    assert.equal(finalStatus.rollback_status, 'COMPLETED');
    assert.equal(finalStatus.rollback_deployment_id, a.id);
    assert.deepEqual(stream.events.at(-1), { event: 'end', data: { deploymentId: b.id, status: 'FAILED' } });

    // 13. History is intact: both deployments are there, and A's record was
    // not rewritten by the rollback.
    assert.deepEqual(await row(a.id), aBefore);
    assert.deepEqual(
      (await history(project)).map(({ id, status }) => ({ id, status })),
      [
        { id: b.id, status: 'FAILED' },
        { id: a.id, status: 'SUCCESS' },
      ],
    );

    const job = await getDeploymentQueue().getJob(b.id);
    await waitFor(async () => (await job.getState()) === 'failed');
    assert.equal((await getDeploymentQueue().getJob(b.id)).attemptsMade, 1);
  });

  test('the stable version is started again from its image when its container is gone', async () => {
    const project = await createProject();
    const a = await deployAndWait(project, healthy());
    assert.equal(a.status, 'SUCCESS', a.error_message);

    // The stable container disappears (crashed and removed, host restarted, ...).
    await docker.removeContainer(a.container_id);
    assert.deepEqual(await liveDeployments(project), []);

    const b = await deployAndWait(project, unhealthy(503));
    assert.equal(b.status, 'FAILED');
    assert.equal(b.rollback_status, 'COMPLETED');
    assert.equal(b.rollback_deployment_id, a.id);

    // A runs again, in a new container started from A's image.
    const restored = await getDeployment(a.id);
    assert.equal(restored.status, 'SUCCESS');
    assert.equal(restored.is_stable, true);
    assert.notEqual(restored.container_id, a.container_id);
    assert.equal(restored.container_name, a.container_name);
    assert.equal(restored.docker_image, a.docker_image);
    assert.equal(restored.finished_at, a.finished_at);
    assert.equal(restored.container_removed_at, null);
    assert.equal(docker.container(restored.container_id).image, a.docker_image);
    assert.deepEqual(await liveDeployments(project), [a.id]);
    assert.equal((await probe(restored)).status, 200);

    assertInOrder(await logLines(b.id), [
      /^INFO Starting automatic rollback$/,
      /^INFO Stopping unhealthy container /,
      new RegExp(`^INFO Starting stable version from image ${a.docker_image}$`),
      /^INFO Running health check on the stable version$/,
      /^INFO Health check attempt 1\/3 passed/,
      /^INFO Stable version is healthy$/,
      /^INFO Rollback completed successfully/,
    ]);
  });

  test('the stable version is restarted by its recorded image ID, not by a tag that may have moved', async () => {
    const project = await createProject();
    const a = await deployAndWait(project, healthy());

    // The real pipeline records the immutable image ID at build time. Here the
    // commit tag no longer exists at all; only the image itself (by ID) does.
    const imageId = `sha256:${'ab12'.repeat(16)}`;
    await pool.query('UPDATE deployments SET docker_image_id = $2 WHERE id = $1', [a.id, imageId]);
    docker.addImage(imageId);
    docker.removeImage(a.docker_image);
    await docker.removeContainer(a.container_id);

    const b = await deployAndWait(project, unhealthy(500));
    assert.equal(b.rollback_status, 'COMPLETED', b.error_message);

    const restored = await getDeployment(a.id);
    assert.equal(docker.container(restored.container_id).image, imageId);
    assert.ok(
      (await logLines(b.id)).includes(`INFO Starting stable version from image ${a.docker_image} (ID ab12ab12ab12)`),
    );
  });

  test('a first deployment that fails its health check is not rolled back: there is no stable version', async () => {
    const recorder = await recordDeploymentEvents();
    try {
      const project = await createProject();
      const deployment = await deployAndWait(project, unhealthy(500));
      await sleep(150);

      assert.equal(deployment.status, 'FAILED');
      assert.equal(deployment.rollback_status, 'NOT_AVAILABLE');
      assert.equal(deployment.rollback_deployment_id, null);
      assert.equal(
        deployment.error_message,
        `Health check failed after 3 attempts: Health check returned HTTP 500. ${NO_STABLE}`,
      );
      assert.ok(deployment.finished_at);

      // No rollback was attempted: the deployment never entered ROLLING_BACK.
      const statuses = recorder.forDeployment(deployment.id).filter((e) => e.type === 'status').map((e) => e.status);
      assert.deepEqual(statuses, ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'FAILED']);

      const lines = await logLines(deployment.id);
      assertInOrder(lines, [
        /^ERROR Health check failed after 3 attempts: Health check returned HTTP 500$/,
        /^ERROR Deployment marked unhealthy$/,
        new RegExp(`^WARN ${NO_STABLE.replace('.', '\\.')}$`),
        /^INFO Stopping unhealthy container /,
        /^ERROR Deployment failed: the application is unhealthy and there is nothing to roll back to$/,
      ]);
      assert.ok(!lines.some((line) => line.includes('Starting automatic rollback')));

      // The unhealthy container does not stay behind, and nothing is stable.
      assert.deepEqual(await liveDeployments(project), []);
      assert.ok((await history(project)).every((d) => d.is_stable === false));
      assert.equal(worker.worker.isRunning(), true);
    } finally {
      await recorder.close();
    }
  });

  test('the rollback fails when the restored version is unhealthy too, and says so', async () => {
    const project = await createProject();
    const commitA = healthy();
    const a = await deployAndWait(project, commitA);
    assert.equal(a.status, 'SUCCESS', a.error_message);
    const aBefore = await row(a.id);

    // Version A stops being healthy (e.g. a dependency it needs went away).
    docker.setApp(commitA, () => 502);
    const b = await deployAndWait(project, unhealthy(500));

    assert.equal(b.status, 'FAILED');
    assert.equal(b.rollback_status, 'FAILED');
    assert.equal(b.rollback_deployment_id, a.id);
    assert.equal(
      b.error_message,
      'Health check failed after 3 attempts: Health check returned HTTP 500. ' +
        `Rollback to deployment ${a.id} failed: the stable deployment is unhealthy too (Health check returned HTTP 502)`,
    );

    const lines = await logLines(b.id);
    assertInOrder(lines, [
      /^INFO Starting automatic rollback$/,
      /^INFO Stable container .* is still running$/,
      /^INFO Running health check on the stable version$/,
      /^WARN Health check attempt 3\/3 failed: Health check returned HTTP 502$/,
      /^ERROR Rollback failed: the stable deployment is unhealthy too \(Health check returned HTTP 502\)$/,
      /^ERROR Deployment failed: the application is unhealthy and the rollback failed$/,
    ]);
    // Nothing claims a recovery.
    assert.ok(!lines.some((line) => /Rollback completed|Stable version is healthy/.test(line)));
    assert.ok(!(await logLines(a.id)).some((line) => line.includes('Restored as the live version')));

    // A's record is untouched and its container was not removed; B's is gone.
    assert.deepEqual(await row(a.id), aBefore);
    assert.deepEqual(await liveDeployments(project), [a.id]);
    assert.equal((await history(project)).length, 2);
  });

  test('the rollback fails when the stable image is no longer available', async () => {
    const project = await createProject();
    const a = await deployAndWait(project, healthy());
    assert.equal(a.status, 'SUCCESS', a.error_message);

    // Neither the container nor the image of the stable version exist any more.
    await docker.removeContainer(a.container_id);
    docker.removeImage(a.docker_image);

    const b = await deployAndWait(project, unhealthy(500));
    assert.equal(b.status, 'FAILED');
    assert.equal(b.rollback_status, 'FAILED');
    assert.equal(b.rollback_deployment_id, a.id);
    assert.match(
      b.error_message,
      new RegExp(`Rollback to deployment ${a.id} failed: image ${a.docker_image} of the stable deployment is no longer available$`),
    );
    assert.ok(
      (await logLines(b.id)).includes(
        `ERROR Rollback failed: image ${a.docker_image} of the stable deployment is no longer available`,
      ),
    );

    // Nothing was started, nothing was marked successful, A is still in the history.
    assert.deepEqual(await liveDeployments(project), []);
    assert.equal((await getDeployment(a.id)).status, 'SUCCESS');
    assert.equal((await history(project)).length, 2);
  });

  test('a restored version that crashes on start fails the rollback', async () => {
    const project = await createProject();
    const a = await deployAndWait(project, healthy());
    await docker.removeContainer(a.container_id);

    // The restarted stable container exits at once.
    const run = docker.runContainer;
    docker.runContainer = async (options) => {
      const id = await run(options);
      if (options.image === a.docker_image) await docker.crash(id);
      return id;
    };
    try {
      const b = await deployAndWait(project, unhealthy(500));
      assert.equal(b.rollback_status, 'FAILED');
      assert.match(b.error_message, /failed: the stable container exited immediately \(exit code 1\)$/);
      assert.deepEqual(await liveDeployments(project), []);
    } finally {
      docker.runContainer = run;
    }
  });

  test('timeouts and refused connections are unhealthy, and the worker keeps running', async () => {
    const project = await createProject();

    const hanging = await deployAndWait(project, version(() => 'hang'));
    assert.equal(hanging.status, 'FAILED');
    assert.equal(
      hanging.error_message,
      `Health check failed after 3 attempts: Health check timed out after 300ms. ${NO_STABLE}`,
    );

    // The container stops listening right after it started.
    const run = docker.runContainer;
    docker.runContainer = async (options) => {
      const id = await run(options);
      docker.container(id).server.close();
      docker.container(id).server.closeAllConnections();
      return id;
    };
    let refused;
    try {
      refused = await deployAndWait(project, healthy());
    } finally {
      docker.runContainer = run;
    }
    assert.equal(refused.status, 'FAILED');
    assert.match(refused.error_message, /^Health check failed after 3 attempts: Connection refused on 127\.0\.0\.1:\d+\./);

    // Neither failure stopped the worker: the next deployment succeeds.
    assert.equal(worker.worker.isRunning(), true);
    const next = await deployAndWait(project, healthy());
    assert.equal(next.status, 'SUCCESS', next.error_message);
    assert.equal(next.is_stable, true);
  });

  test('a rollback interrupted by a worker restart ends as a failed rollback, not a second one', async () => {
    const project = await createProject();
    const a = await deployAndWait(project, healthy());

    await worker.worker.pause();
    const stuck = await deploy(project, unhealthy(500));
    // As left behind by a worker that died in the middle of the rollback.
    for (const status of ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK']) {
      await pool.query('SELECT transition_deployment_status($1, $2)', [stuck.id, status]);
    }
    await pool.query('UPDATE deployments SET rollback_deployment_id = $2 WHERE id = $1', [stuck.id, a.id]);
    worker.worker.resume();

    const failed = await finished(stuck);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.rollback_status, 'FAILED');
    assert.equal(failed.rollback_deployment_id, a.id);
    assert.equal(failed.error_message, 'The worker stopped during the rollback; the rollback did not complete');
    assert.ok((await logLines(stuck.id)).includes('ERROR Deployment failed: the rollback was interrupted'));
    assert.deepEqual(await liveDeployments(project), [a.id]);
  });
});

describe('concurrent deployments', () => {
  test('projects are rolled back independently, each to its own stable deployment', async () => {
    const [projectA, projectB, projectC] = await Promise.all([createProject(), createProject(), createProject()]);
    const stableA = await deployAndWait(projectA, healthy());
    const stableB = await deployAndWait(projectB, healthy());

    // At the same time: A gets an unhealthy version, B a healthy one, and C
    // (which never had a stable deployment) an unhealthy one.
    const [badA, goodB, badC] = await Promise.all([
      deployAndWait(projectA, unhealthy(500)),
      deployAndWait(projectB, healthy()),
      deployAndWait(projectC, unhealthy(500)),
    ]);

    assert.equal(badA.status, 'FAILED');
    assert.equal(badA.rollback_status, 'COMPLETED');
    assert.equal(badA.rollback_deployment_id, stableA.id);

    assert.equal(goodB.status, 'SUCCESS', goodB.error_message);
    assert.equal(goodB.is_stable, true);

    // C is never rolled back using another project's deployment.
    assert.equal(badC.status, 'FAILED');
    assert.equal(badC.rollback_status, 'NOT_AVAILABLE');
    assert.equal(badC.rollback_deployment_id, null);

    await waitFor(async () => (await liveDeployments(projectB)).length === 1);
    assert.deepEqual(await liveDeployments(projectA), [stableA.id]);
    assert.deepEqual(await liveDeployments(projectB), [goodB.id]);
    assert.deepEqual(await liveDeployments(projectC), []);
    assert.equal((await getDeployment(stableA.id)).is_stable, true);
    assert.equal((await getDeployment(stableB.id)).is_stable, false);
    assert.ok((await getDeployment(stableB.id)).container_removed_at);
  });

  test('same project: a healthy deployment is promoted first, so the unhealthy one rolls back to it', async () => {
    const project = await createProject();
    const stable = await deployAndWait(project, healthy());

    // C passes its first attempt; D needs three failed attempts.
    const [c, d] = await Promise.all([deployAndWait(project, healthy()), deployAndWait(project, unhealthy(500))]);

    assert.equal(c.status, 'SUCCESS', c.error_message);
    assert.equal(d.status, 'FAILED');
    assert.equal(d.rollback_status, 'COMPLETED');
    assert.equal(d.rollback_deployment_id, c.id);

    await waitFor(async () => (await liveDeployments(project)).length === 1);
    assert.deepEqual(await liveDeployments(project), [c.id]);
    assert.equal((await getDeployment(c.id)).is_stable, true);
    // The previous stable deployment was replaced by C, and is kept as history.
    const previous = await getDeployment(stable.id);
    assert.equal(previous.status, 'SUCCESS');
    assert.ok(previous.container_removed_at);
    assert.equal((await history(project)).length, 3);
  });

  test('same project: the unhealthy deployment rolls back first, then the healthy one is promoted', async () => {
    const project = await createProject();
    const stable = await deployAndWait(project, healthy());

    // C only answers after 200ms; D has failed all its attempts by then.
    const slow = version(async () => {
      await sleep(200);
      return 200;
    });
    const [c, d] = await Promise.all([deployAndWait(project, slow), deployAndWait(project, unhealthy(500))]);

    assert.equal(c.status, 'SUCCESS', c.error_message);
    assert.equal(d.status, 'FAILED');
    assert.equal(d.rollback_status, 'COMPLETED');
    // D was rolled back to what was stable at that moment. C's container was
    // still being verified and was left alone.
    assert.equal(d.rollback_deployment_id, stable.id);

    await waitFor(async () => (await liveDeployments(project)).length === 1);
    assert.deepEqual(await liveDeployments(project), [c.id]);
    assert.equal((await getDeployment(c.id)).is_stable, true);
    assert.equal((await getDeployment(stable.id)).is_stable, false);
    assert.equal((await probe(c)).status, 200);
  });

  test('same project: two healthy deployments leave exactly one container, the stable one', async () => {
    const project = await createProject();
    const [first, second] = await Promise.all([deployAndWait(project, healthy()), deployAndWait(project, healthy())]);
    assert.equal(first.status, 'SUCCESS', first.error_message);
    assert.equal(second.status, 'SUCCESS', second.error_message);

    await waitFor(async () => (await liveDeployments(project)).length === 1);
    const { rows } = await pool.query('SELECT stable_deployment_id($1) AS id', [project.id]);
    assert.deepEqual(await liveDeployments(project), [rows[0].id]);
    assert.ok([first.id, second.id].includes(rows[0].id));
  });
});
