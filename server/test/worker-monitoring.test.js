// Worker observability: Redis heartbeats, the worker's /health, /ready and
// /metrics endpoint, outcome metrics and structured job logs. The real worker
// runs in this process with the fast fake pipeline (fakePipeline.js).
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { FAIL_BRANCH, createFakePipeline } from './fakePipeline.js';
import { pool, projectPayload, setupTestServer, waitFor } from './helpers.js';
import redisConnection from '../src/db/redis.js';

let api;
let project;
let workerModule;
let processorModule;
let heartbeatModule;
let monitoringModule;
let healthCheckModule;
let closeWorkerPostgres;
const lines = [];

before(async () => {
  for (const method of ['log', 'warn', 'error']) mock.method(console, method, (...args) => lines.push(args.join(' ')));
  api = await setupTestServer();
  workerModule = await import('../../worker/src/worker.js');
  processorModule = await import('../../worker/src/processors/deploymentProcessor.js');
  heartbeatModule = await import('../../worker/src/services/heartbeat.js');
  monitoringModule = await import('../../worker/src/monitoringServer.js');
  healthCheckModule = await import('../../worker/src/services/healthCheckService.js');
  ({ closePostgres: closeWorkerPostgres } = await import('../../worker/src/db/postgres.js'));
  project = (await api.post('/api/projects', projectPayload())).body.data;
});

after(async () => {
  await api.close();
  await closeWorkerPostgres();
  mock.restoreAll();
});

function startWorker(stepMs = 150) {
  return workerModule.createDeploymentWorker({
    concurrency: 2,
    processor: processorModule.createDeploymentProcessor({ pipeline: createFakePipeline({ stepMs }) }),
  });
}

async function deploy(body = {}) {
  return (await api.post(`/api/projects/${project.id}/deployments`, body)).body.data.deployment;
}

async function statusOf(id) {
  return (await pool.query('SELECT status FROM deployments WHERE id = $1', [id])).rows[0].status;
}

async function get(port, path, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: response.status, text: await response.text() };
}

describe('heartbeat', () => {
  test('each worker publishes its state in Redis with a TTL, and removes it on shutdown', async () => {
    const running = startWorker(400);
    const beat = heartbeatModule.startHeartbeat({
      connection: running.connection,
      getActiveJobs: running.activeJobs,
      intervalMs: 100,
      concurrency: 2,
    });
    try {
      await beat.ready;
      const key = `${process.env.QUEUE_PREFIX}:workers:${beat.workerId}`;
      const first = JSON.parse(await redisConnection.get(key));
      assert.equal(first.id, beat.workerId);
      assert.equal(first.status, 'running');
      assert.equal(first.pid, process.pid);
      assert.equal(first.concurrency, 2);
      assert.equal(first.activeJobs, 0);
      // Three intervals: a worker that stops beating (killed, hung, cut off
      // from Redis) disappears by itself.
      const ttl = await redisConnection.pttl(key);
      assert.ok(ttl > 0 && ttl <= 300, `ttl ${ttl}`);

      // A running job shows up in the next beat.
      const deployment = await deploy();
      await waitFor(async () => JSON.parse(await redisConnection.get(key)).activeJobs === 1, { timeout: 5000 });
      await waitFor(async () => (await statusOf(deployment.id)) === 'SUCCESS', { timeout: 10000 });
      await waitFor(async () => JSON.parse(await redisConnection.get(key)).activeJobs === 0, { timeout: 5000 });

      await beat.markStopping();
      assert.equal(JSON.parse(await redisConnection.get(key)).status, 'stopping');
      await beat.stop();
      assert.equal(await redisConnection.get(key), null);
    } finally {
      await beat.stop();
      await running.close();
    }
  });
});

describe('monitoring endpoint', () => {
  let running;
  let monitoring;
  let port;
  let stopping = false;

  before(async () => {
    running = startWorker();
    await running.worker.waitUntilReady();
    monitoring = monitoringModule.startMonitoringServer({
      worker: running.worker,
      connection: running.connection,
      isStopping: () => stopping,
      port: 0,
      token: '',
    });
    await new Promise((resolve) => monitoring.server.once('listening', resolve));
    port = monitoring.server.address().port;
  });

  after(async () => {
    await monitoring.close();
    await running.close().catch(() => {});
  });

  test('liveness and readiness', async () => {
    assert.equal((await get(port, '/health')).status, 200);
    const ready = await get(port, '/ready');
    assert.equal(ready.status, 200, ready.text);
    assert.deepEqual(JSON.parse(ready.text).checks, { redis: 'ok', postgres: 'ok', worker: 'running' });
    assert.equal((await get(port, '/anything')).status, 404);

    stopping = true;
    const draining = await get(port, '/ready');
    assert.equal(draining.status, 503);
    assert.equal(JSON.parse(draining.text).checks.worker, 'stopping');
    assert.equal((await get(port, '/health')).status, 200, 'still alive while draining');
    stopping = false;
  });

  test('outcome, duration, job and health-check metrics come from what really happened', async () => {
    const ok = await deploy();
    const failed = await deploy({ branch: FAIL_BRANCH });
    await waitFor(async () => (await statusOf(ok.id)) === 'SUCCESS', { timeout: 10000 });
    await waitFor(async () => (await statusOf(failed.id)) === 'FAILED', { timeout: 15000 });

    // A failing health-check attempt.
    await healthCheckModule.waitForHealthy({
      port: 1,
      path: '/health',
      retries: 1,
      startupGracePeriod: 0,
      check: async () => ({ healthy: false, error: 'HTTP 503' }),
    });

    // The deployment is FAILED before BullMQ reports the job as failed: wait
    // for that event to be counted.
    const { status, text } = await waitFor(
      async () => {
        const scraped = await get(port, '/metrics');
        return /deployx_worker_jobs_failed_total\{final="true",service="deployx-worker"\} [1-9]/.test(scraped.text) &&
          /deployx_worker_jobs_active\{service="deployx-worker"\} 0/.test(scraped.text)
          ? scraped
          : null;
      },
      { timeout: 5000 },
    );
    assert.equal(status, 200);
    assert.match(text, /deployx_deployments_success_total\{target="LOCAL",service="deployx-worker"\} [1-9]/);
    assert.match(text, /deployx_deployments_failed_total\{status="FAILED",target="LOCAL",service="deployx-worker"\} [1-9]/);
    assert.match(text, /deployx_deployment_duration_seconds_count\{service="deployx-worker",status="SUCCESS",target="LOCAL"\} [1-9]/);
    assert.match(text, /deployx_worker_jobs_completed_total\{service="deployx-worker"\} [1-9]/);
    assert.match(text, /deployx_worker_jobs_failed_total\{final="false",service="deployx-worker"\} [1-9]/);
    assert.match(text, /deployx_worker_jobs_failed_total\{final="true",service="deployx-worker"\} [1-9]/);
    assert.match(text, /deployx_worker_jobs_active\{service="deployx-worker"\} 0/);
    assert.match(text, /deployx_health_check_failures_total\{service="deployx-worker"\} [1-9]/);
  });

  test('the metrics token is enforced when configured', async () => {
    const guarded = monitoringModule.startMonitoringServer({
      worker: running.worker,
      connection: running.connection,
      port: 0,
      token: 'worker-scrape-token',
    });
    await new Promise((resolve) => guarded.server.once('listening', resolve));
    const guardedPort = guarded.server.address().port;
    try {
      assert.equal((await get(guardedPort, '/metrics')).status, 401);
      assert.equal((await get(guardedPort, '/metrics', { authorization: 'Bearer worker-scrape-token' })).status, 200);
      assert.equal((await get(guardedPort, '/health')).status, 200, 'probes need no token');
    } finally {
      await guarded.close();
    }
  });

  test('a closed worker is not ready', async () => {
    await running.close();
    const ready = await get(port, '/ready');
    assert.equal(ready.status, 503);
  });
});

describe('job logs', () => {
  test('are JSON lines with job, deployment, project, status and duration', () => {
    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const worker = entries.filter((entry) => entry.service === 'deployx-worker');
    const started = worker.find((entry) => entry.event === 'job_started');
    assert.ok(started.jobId && started.deploymentId && started.projectId, JSON.stringify(started));
    const completed = worker.find((entry) => entry.event === 'deployment_completed');
    assert.equal(completed.status, 'SUCCESS');
    assert.equal(typeof completed.durationMs, 'number');
    assert.ok(completed.deploymentId && completed.projectId);
    const failed = worker.find((entry) => entry.event === 'deployment_failed');
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error, /Fake build failure/);
    assert.ok(worker.some((entry) => entry.event === 'job_failed' && entry.final === true));
  });
});
