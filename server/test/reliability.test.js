// Reliability under infrastructure failures: Redis going away and coming
// back (for the API and under a running worker), PostgreSQL failing while a
// job starts, and a worker that died in the middle of a deployment. In every
// case the API keeps answering, and every deployment ends in a meaningful
// final state instead of hanging.
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import IORedis from 'ioredis';
import { createFakePipeline } from './fakePipeline.js';
import { pool, projectPayload, setupTestServer, waitFor } from './helpers.js';
import redisConnection from '../src/db/redis.js';

let api;
let project;
let admin;
let workerModule;
let processorModule;
let workerPool;

before(async () => {
  for (const method of ['log', 'warn', 'error']) mock.method(console, method, () => {});
  api = await setupTestServer();
  admin = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
  workerModule = await import('../../worker/src/worker.js');
  processorModule = await import('../../worker/src/processors/deploymentProcessor.js');
  workerPool = (await import('../../worker/src/db/postgres.js')).default;
  project = (await api.post('/api/projects', projectPayload())).body.data;
});

after(async () => {
  await api.close();
  await admin.quit();
  await workerPool.end();
  mock.restoreAll();
});

function startWorker(stepMs = 150) {
  return workerModule.createDeploymentWorker({
    concurrency: 1,
    processor: processorModule.createDeploymentProcessor({ pipeline: createFakePipeline({ stepMs }) }),
  });
}

async function statusOf(id) {
  return (await pool.query('SELECT status FROM deployments WHERE id = $1', [id])).rows[0].status;
}

async function waitForStatus(id, status, timeout = 15000) {
  await waitFor(async () => (await statusOf(id)) === status, { timeout, interval: 50 });
}

async function logsOf(id) {
  const { rows } = await pool.query('SELECT message FROM deployment_logs WHERE deployment_id = $1 ORDER BY id', [id]);
  return rows.map((row) => row.message);
}

// Closes every Redis connection of a worker from the server side, as a Redis
// restart does.
async function killWorkerConnections(running) {
  const id = await running.connection.client('ID');
  await admin.client('KILL', 'ID', String(id));
  const clients = (await admin.client('LIST')).split('\n');
  for (const line of clients) {
    const name = /\bname=(\S+)/.exec(line)?.[1] ?? '';
    const clientId = /\bid=(\d+)/.exec(line)?.[1];
    if (clientId && name.startsWith(`${process.env.QUEUE_PREFIX}:`)) await admin.client('KILL', 'ID', clientId).catch(() => {});
  }
}

describe('Redis outage seen by the API', () => {
  test('the API stays alive, reports not ready, refuses to queue (recorded as FAILED), and recovers', async () => {
    redisConnection.disconnect();
    await waitFor(() => redisConnection.status === 'end', { timeout: 3000 });
    try {
      assert.equal((await api.anonymous.get('/health')).status, 200, 'liveness does not depend on Redis');
      const ready = await api.anonymous.get('/ready');
      assert.equal(ready.status, 503);
      assert.equal(ready.body.data.checks.redis, 'unavailable');

      // Rate limits fall back to memory: requests are still served.
      assert.equal((await api.get('/api/projects')).status, 200);

      const refused = await api.post(`/api/projects/${project.id}/deployments`, {});
      assert.equal(refused.status, 503);
      const { rows } = await pool.query(
        'SELECT id, status, error_message FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
        [project.id],
      );
      assert.equal(rows[0].status, 'FAILED', 'never left QUEUED without a job');
      assert.equal(rows[0].error_message, 'Deployment queue is unavailable');

      const overview = await api.get('/api/monitoring/overview');
      assert.equal(overview.body.data.dependencies.redis, 'down');
      assert.ok(overview.body.data.alerts.some((alert) => alert.id === 'REDIS_UNAVAILABLE'));
      assert.equal(overview.body.data.workers, null, 'unknown, not "zero workers"');
    } finally {
      redisConnection.connect().catch(() => {});
      await waitFor(() => redisConnection.status === 'ready', { timeout: 5000 });
    }

    assert.equal((await api.anonymous.get('/ready')).status, 200);
    const queued = await api.post(`/api/projects/${project.id}/deployments`, {});
    assert.equal(queued.status, 201);
    assert.equal(queued.body.data.deployment.status, 'QUEUED');
  });
});

describe('Redis restart under a running worker', () => {
  test('the worker reconnects by itself, finishes the job it was running and takes new ones', async () => {
    const running = startWorker(600);
    await running.worker.waitUntilReady();
    try {
      // Drain what the previous test queued.
      const { rows: leftover } = await pool.query(`SELECT id FROM deployments WHERE status = 'QUEUED'`);
      for (const row of leftover) await waitForStatus(row.id, 'SUCCESS');

      const first = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
      await waitForStatus(first.id, 'BUILDING');
      await killWorkerConnections(running);
      await waitForStatus(first.id, 'SUCCESS', 20000);

      await killWorkerConnections(running);
      const second = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
      await waitForStatus(second.id, 'SUCCESS', 20000);
      assert.equal((await logsOf(second.id)).filter((line) => line.startsWith('Deployment job started')).length, 1);
    } finally {
      await running.close();
    }
  });
});

describe('PostgreSQL failing while a job starts', () => {
  test('the attempt fails, BullMQ retries it, and the deployment still completes', async (t) => {
    const original = workerPool.query.bind(workerPool);
    let failures = 0;
    t.mock.method(workerPool, 'query', (...args) => {
      if (failures < 2) {
        failures += 1;
        return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' }));
      }
      return original(...args);
    });

    const running = startWorker(50);
    try {
      const deployment = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
      await waitForStatus(deployment.id, 'SUCCESS', 20000);
      assert.equal(failures, 2);
      const starts = (await logsOf(deployment.id)).filter((line) => line.startsWith('Deployment job started'));
      assert.match(starts.at(-1), /attempt [23] of 3/, 'a later attempt did the work');
    } finally {
      await running.close();
    }
  });
});

describe('a worker that died in the middle of a deployment', () => {
  test('the next worker picks the job up and starts the attempt again from the beginning', async () => {
    // A deployment whose worker died while BUILDING: the job is back in the
    // queue (BullMQ's stalled-job check) and the record still says BUILDING.
    const deployment = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
    await pool.query(`SELECT transition_deployment_status($1, 'BUILDING')`, [deployment.id]);

    const running = startWorker(50);
    try {
      await waitForStatus(deployment.id, 'SUCCESS');
      const lines = await logsOf(deployment.id);
      assert.ok(lines.includes('Previous attempt was interrupted during BUILDING; starting again'), lines.join('\n'));
    } finally {
      await running.close();
    }
  });
});
