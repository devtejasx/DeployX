// End-to-end tests for the deployment job system:
//   API -> BullMQ (Redis) -> worker -> PostgreSQL
//
// The real worker (../../worker/src) runs in this process against the test
// database and the test queue prefix, with short simulated stages. Worker
// dependencies must be installed (npm run install:all).
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { getDeploymentQueue, pool, projectPayload, setupTestServer } from './helpers.js';

const STEP_MS = 300;
const CONCURRENCY = 2;

let api;
let project;
let createDeploymentWorker;
let createDeploymentProcessor;
let closeWorkerPostgres;

before(async () => {
  // Worker output is expected and noisy (including deliberate failures).
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});

  api = await setupTestServer();
  // Imported after setupTestServer() so the worker reads the test settings.
  ({ createDeploymentWorker } = await import('../../worker/src/worker.js'));
  ({ createDeploymentProcessor } = await import('../../worker/src/processors/deploymentProcessor.js'));
  ({ closePostgres: closeWorkerPostgres } = await import('../../worker/src/db/postgres.js'));

  project = (await api.post('/api/projects', projectPayload())).body.data;
});

after(async () => {
  await api.close();
  await closeWorkerPostgres();
  mock.restoreAll();
});

function startWorker() {
  return createDeploymentWorker({
    concurrency: CONCURRENCY,
    processor: createDeploymentProcessor({ stepMs: STEP_MS }),
  });
}

async function waitFor(check, { timeout = 15000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function deploy(body = {}) {
  const started = performance.now();
  const response = await api.post(`/api/projects/${project.id}/deployments`, body);
  const elapsedMs = performance.now() - started;
  assert.equal(response.status, 201);
  return { ...response.body.data, elapsedMs };
}

async function getStatus(deploymentId) {
  const { rows } = await pool.query('SELECT status FROM deployments WHERE id = $1', [deploymentId]);
  return rows[0]?.status;
}

async function waitForStatus(deploymentId, statuses) {
  return waitFor(async () => {
    const status = await getStatus(deploymentId);
    return statuses.includes(status) ? status : null;
  });
}

async function logMessages(deploymentId) {
  const { rows } = await pool.query(
    'SELECT level, message FROM deployment_logs WHERE deployment_id = $1 ORDER BY id',
    [deploymentId],
  );
  return rows.map(({ level, message }) => `${level} ${message}`);
}

describe('single deployment job', () => {
  let worker;
  before(() => {
    worker = startWorker();
  });
  after(() => worker.close());

  test('the API returns QUEUED immediately, without waiting for the job', async () => {
    const { deployment, jobId, elapsedMs } = await deploy({ commit_sha: 'abc1234' });

    assert.equal(deployment.status, 'QUEUED');
    assert.equal(jobId, deployment.id);
    // The simulated job takes at least 2 x STEP_MS; the API answers well before.
    assert.ok(elapsedMs < STEP_MS, `API took ${elapsedMs.toFixed(0)}ms`);
    assert.notEqual(await getStatus(deployment.id), 'SUCCESS');

    await waitForStatus(deployment.id, ['SUCCESS']);
  });

  test('walks QUEUED -> BUILDING -> DEPLOYING -> SUCCESS and records it in PostgreSQL', async () => {
    const { deployment } = await deploy({ commit_sha: 'def5678' });

    const seen = [];
    await waitFor(async () => {
      const status = await getStatus(deployment.id);
      if (seen.at(-1) !== status) seen.push(status);
      return status === 'SUCCESS';
    });
    // Polling can miss the initial QUEUED, but never reorders states.
    assert.deepEqual(seen.filter((status) => status !== 'QUEUED'), ['BUILDING', 'DEPLOYING', 'SUCCESS']);

    const { rows } = await pool.query(
      'SELECT started_at, finished_at, created_at FROM deployments WHERE id = $1',
      [deployment.id],
    );
    assert.ok(rows[0].started_at >= rows[0].created_at);
    assert.ok(rows[0].finished_at - rows[0].started_at >= 2 * STEP_MS - 50);

    assert.deepEqual(await logMessages(deployment.id), [
      'INFO Deployment created',
      'INFO Deployment job started (attempt 1 of 3)',
      'INFO Deployment is now building',
      'INFO Build simulation completed (no image was built)',
      'INFO Deployment is now deploying',
      'INFO Deployment simulation completed (no container was started)',
      'INFO Deployment completed successfully',
    ]);

    const job = await getDeploymentQueue().getJob(deployment.id);
    assert.equal(await job.getState(), 'completed');
    assert.deepEqual(job.returnvalue, { status: 'SUCCESS' });
  });
});

describe('concurrency', () => {
  let worker;
  before(() => {
    worker = startWorker();
  });
  after(() => worker.close());

  test(`runs at most ${CONCURRENCY} jobs at once and queues the rest`, async () => {
    const deployments = [];
    for (let i = 0; i < 4; i += 1) {
      deployments.push((await deploy()).deployment);
    }
    const ids = deployments.map((deployment) => deployment.id);

    let maxActive = 0;
    let sawTwoRunningTwoWaiting = false;
    await waitFor(async () => {
      const counts = await getDeploymentQueue().getJobCounts('active', 'waiting');
      maxActive = Math.max(maxActive, counts.active);
      if (counts.active === 2 && counts.waiting === 2) sawTwoRunningTwoWaiting = true;

      const { rows } = await pool.query('SELECT status FROM deployments WHERE id = ANY($1)', [ids]);
      return rows.every((row) => row.status === 'SUCCESS');
    });

    assert.equal(maxActive, CONCURRENCY);
    assert.ok(sawTwoRunningTwoWaiting, 'expected a moment with 2 jobs running and 2 waiting');

    // The 3rd and 4th deployments only started after one of the first two finished.
    const { rows } = await pool.query('SELECT id, started_at, finished_at FROM deployments WHERE id = ANY($1)', [ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const [first, second, third, fourth] = ids.map((id) => byId.get(id));
    const firstFinish = Math.min(first.finished_at, second.finished_at);
    assert.ok(third.started_at >= firstFinish);
    assert.ok(fourth.started_at >= firstFinish);
  });
});

describe('retries and failures', () => {
  let worker;
  before(() => {
    worker = startWorker();
  });
  after(() => worker.close());

  test('a job that always fails is tried 3 times and the deployment ends FAILED', async () => {
    const { deployment } = await deploy({ branch: 'simulate/fail' });
    await waitForStatus(deployment.id, ['FAILED']);

    const failure = 'Simulated build failure (branch "simulate/fail" always fails)';
    const logs = await logMessages(deployment.id);
    assert.deepEqual(
      logs.filter((line) => line.startsWith('ERROR') || line.startsWith('WARN') || line.includes('job started')),
      [
        'INFO Deployment job started (attempt 1 of 3)',
        `ERROR Attempt 1 of 3 failed: ${failure}`,
        'WARN Retrying in 0.2s (attempt 2 of 3)',
        'INFO Deployment job started (attempt 2 of 3)',
        `ERROR Attempt 2 of 3 failed: ${failure}`,
        'WARN Retrying in 0.4s (attempt 3 of 3)',
        'INFO Deployment job started (attempt 3 of 3)',
        `ERROR Attempt 3 of 3 failed: ${failure}`,
        'ERROR Deployment failed after maximum retry attempts',
      ],
    );

    const { rows } = await pool.query('SELECT started_at, finished_at FROM deployments WHERE id = $1', [deployment.id]);
    assert.ok(rows[0].started_at);
    assert.ok(rows[0].finished_at);

    const job = await getDeploymentQueue().getJob(deployment.id);
    await waitFor(async () => (await job.getState()) === 'failed');
    const failedJob = await getDeploymentQueue().getJob(deployment.id);
    assert.equal(failedJob.attemptsMade, 3);
    assert.equal(failedJob.failedReason, failure);
  });

  test('a job that fails twice succeeds on its last attempt', async () => {
    const { deployment } = await deploy({ branch: 'simulate/flaky' });
    await waitForStatus(deployment.id, ['SUCCESS', 'FAILED']);

    assert.equal(await getStatus(deployment.id), 'SUCCESS');
    const logs = await logMessages(deployment.id);
    assert.equal(logs.filter((line) => line.startsWith('ERROR Attempt')).length, 2);
    assert.equal(logs.at(-1), 'INFO Deployment completed successfully');
  });

  test('a failing job does not stop other jobs or the worker', async () => {
    const failing = (await deploy({ branch: 'simulate/fail' })).deployment;
    const healthy = (await deploy({ branch: 'main' })).deployment;

    await waitForStatus(healthy.id, ['SUCCESS']);
    await waitForStatus(failing.id, ['FAILED']);
    assert.equal(worker.worker.isRunning(), true);

    // The worker keeps accepting new work afterwards.
    const next = (await deploy()).deployment;
    await waitForStatus(next.id, ['SUCCESS']);
  });
});

describe('duplicates and removed deployments', () => {
  let worker;
  before(() => {
    worker = startWorker();
  });
  after(() => worker.close());

  test('queueing the same deployment twice creates one job', async () => {
    const { deployment } = await deploy();
    const queue = getDeploymentQueue();
    const duplicate = await queue.add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id });
    assert.equal(duplicate.id, deployment.id);

    await waitForStatus(deployment.id, ['SUCCESS']);
    const started = (await logMessages(deployment.id)).filter((line) => line.includes('job started'));
    assert.equal(started.length, 1);
  });

  test('a job re-added for a finished deployment does nothing', async () => {
    const { deployment } = await deploy();
    await waitForStatus(deployment.id, ['SUCCESS']);
    const logsBefore = await logMessages(deployment.id);

    const queue = getDeploymentQueue();
    await waitFor(async () => (await (await queue.getJob(deployment.id)).getState()) === 'completed');
    await (await queue.getJob(deployment.id)).remove();
    await queue.add('deploy', { deploymentId: deployment.id }, { jobId: deployment.id });

    const job = await waitFor(async () => {
      const current = await queue.getJob(deployment.id);
      return (await current.getState()) === 'completed' ? current : null;
    });
    assert.deepEqual(job.returnvalue, {
      skipped: true,
      reason: 'Deployment already finished with status SUCCESS',
    });
    assert.equal(await getStatus(deployment.id), 'SUCCESS');
    assert.deepEqual(await logMessages(deployment.id), logsBefore);
  });

  test('a job whose deployment was deleted while waiting is skipped', async () => {
    await worker.worker.pause();
    const doomedProject = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${doomedProject.id}/deployments`, {})).body.data;
    await api.delete(`/api/projects/${doomedProject.id}`);
    worker.worker.resume();

    const queue = getDeploymentQueue();
    const job = await waitFor(async () => {
      const current = await queue.getJob(deployment.id);
      return (await current.getState()) === 'completed' ? current : null;
    });
    assert.deepEqual(job.returnvalue, { skipped: true, reason: 'Deployment no longer exists' });
  });
});

describe('graceful shutdown', () => {
  test('close() stops taking new jobs but lets the running job finish', async () => {
    const worker = startWorker();
    const { deployment: running } = await deploy();
    await waitForStatus(running.id, ['BUILDING']);

    const closing = worker.close();
    // Queued after shutdown began: must not be picked up by this worker.
    const { deployment: queuedLater } = await deploy();
    await closing;

    assert.equal(await getStatus(running.id), 'SUCCESS');
    assert.equal(await getStatus(queuedLater.id), 'QUEUED');
    assert.equal(await (await getDeploymentQueue().getJob(queuedLater.id)).getState(), 'waiting');

    // A new worker picks the waiting job up.
    const next = startWorker();
    await waitForStatus(queuedLater.id, ['SUCCESS']);
    await next.close();
  });
});
