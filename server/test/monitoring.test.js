// The monitoring overview (GET /api/monitoring/overview) and its alerts: real
// worker heartbeats and queue counts from Redis, deployment facts from
// PostgreSQL, scoped per user.
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import IORedis from 'ioredis';
import { pool, projectPayload, setupTestServer } from './helpers.js';
import config from '../src/config/index.js';
import { evaluateAlerts } from '../src/services/monitoring.service.js';

let api;
let alice;
let bob;
let redis;
let heartbeat;

before(async () => {
  mock.method(console, 'log', () => {});
  api = await setupTestServer();
  alice = await api.clientFor({ name: 'Alice', email: 'alice@example.com' });
  bob = await api.clientFor({ name: 'Bob', email: 'bob@example.com' });
  redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
  heartbeat = await import('../../worker/src/services/heartbeat.js');
  const stale = await redis.keys(`${process.env.QUEUE_PREFIX}:workers:*`);
  if (stale.length) await redis.del(...stale);
});

after(async () => {
  await api.close();
  await redis.quit();
  mock.restoreAll();
});

async function overview(client) {
  const response = await client.get('/api/monitoring/overview');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

const alertIds = (data) => data.alerts.map((alert) => alert.id).sort();

// A finished (or unfinished) deployment written straight into PostgreSQL.
async function insertDeployment(projectId, status, extra = {}) {
  const finished = ['SUCCESS', 'FAILED', 'ROLLBACK_FAILED'].includes(status);
  const { rows } = await pool.query(
    `INSERT INTO deployments (project_id, branch, status, deployment_target, error_message, rollback_status,
                              started_at, finished_at, created_at, updated_at)
     VALUES ($1, 'main', $2::varchar, $3, $4, $5,
             now() - make_interval(mins => $6 + 1), CASE WHEN $7 THEN now() - make_interval(mins => $6) END,
             now() - make_interval(mins => $6 + 2), now() - make_interval(mins => $6))
     RETURNING id`,
    [
      projectId,
      status,
      extra.target ?? 'LOCAL',
      extra.error ?? (finished && status !== 'SUCCESS' ? 'Docker build failed' : null),
      extra.rollback ?? null,
      extra.minutesAgo ?? 5,
      finished,
    ],
  );
  return rows[0].id;
}

describe('workers and queue', () => {
  test('no heartbeat means no worker: a critical alert, not a fake "running"', async () => {
    const data = await overview(api);
    assert.equal(data.workers.running, 0);
    assert.deepEqual(data.workers.list, []);
    assert.ok(alertIds(data).includes('WORKER_UNAVAILABLE'));
    assert.deepEqual(data.dependencies, { postgres: 'up', redis: 'up' });
  });

  test('a live heartbeat shows the worker; host names only for ADMIN', async () => {
    const beat = heartbeat.startHeartbeat({ connection: redis, getActiveJobs: () => 1, intervalMs: 1000, concurrency: 2 });
    await beat.ready;
    try {
      const admin = await overview(api);
      assert.equal(admin.workers.running, 1);
      assert.equal(admin.workers.activeJobs, 1);
      assert.equal(admin.workers.capacity, 2);
      assert.equal(admin.workers.list[0].id, beat.workerId);
      assert.ok(admin.workers.list[0].hostname);
      assert.ok(admin.workers.list[0].heartbeatAgeSeconds <= 2);
      assert.ok(!alertIds(admin).includes('WORKER_UNAVAILABLE'));

      const user = await overview(alice);
      assert.equal(user.workers.running, 1);
      assert.equal(user.workers.list[0].hostname, undefined);

      const metrics = await (await fetch(`${api.baseUrl}/metrics`)).text();
      assert.match(metrics, /deployx_workers\{status="running",service="deployx-api"\} 1/);

      await beat.markStopping();
      const stopping = await overview(api);
      assert.equal(stopping.workers.running, 0);
      assert.equal(stopping.workers.stopping, 1);
      assert.ok(alertIds(stopping).includes('WORKER_UNAVAILABLE'), 'a draining worker takes no new jobs');
    } finally {
      await beat.stop();
    }
  });

  test('queued deployments count as backlog', async (t) => {
    t.after(() => {
      config.alerts.queueBacklog = 10;
    });
    config.alerts.queueBacklog = 2;
    const project = (await alice.post('/api/projects', projectPayload())).body.data;
    await alice.post(`/api/projects/${project.id}/deployments`, {});
    await alice.post(`/api/projects/${project.id}/deployments`, {});
    const data = await overview(alice);
    assert.ok(data.queue.depth >= 2, JSON.stringify(data.queue));
    assert.ok(data.deployments.inProgress.QUEUED >= 2);
    assert.ok(data.deployments.active.every((deployment) => deployment.project_name === project.name));
    assert.ok(alertIds(data).includes('QUEUE_BACKLOG'));
    assert.equal(data.projects.list.find((entry) => entry.id === project.id).state, 'deploying');
  });
});

describe('deployment facts and alerts', () => {
  test('failures, rollbacks and project states come from the deployment records', async () => {
    const make = async (name) => (await alice.post('/api/projects', projectPayload({ name }))).body.data;
    const healthy = await make('healthy-app');
    const flaky = await make('flaky-app');
    const broken = await make('broken-app');
    const rolledBack = await make('rolled-back-app');
    await make('new-app');
    const cloud = await make('cloud-app');

    await insertDeployment(healthy.id, 'SUCCESS');
    for (let i = 0; i < 3; i += 1) {
      await insertDeployment(flaky.id, 'FAILED', { rollback: 'COMPLETED', error: 'Health check failed after 5 attempts: HTTP 503', minutesAgo: 10 + i });
    }
    await insertDeployment(broken.id, 'ROLLBACK_FAILED', { rollback: 'FAILED', error: 'Health check failed after 5 attempts: timeout' });
    await insertDeployment(rolledBack.id, 'FAILED', { rollback: 'COMPLETED', minutesAgo: 1 });
    for (let i = 0; i < 3; i += 1) await insertDeployment(cloud.id, 'FAILED', { target: 'AWS_ECS', error: 'ECS rollout failed' });

    const data = await overview(alice);
    const states = Object.fromEntries(data.projects.list.map((project) => [project.name, project.state]));
    assert.equal(states['healthy-app'], 'healthy');
    assert.equal(states['flaky-app'], 'rolled_back');
    assert.equal(states['broken-app'], 'rollback_failed');
    assert.equal(states['rolled-back-app'], 'rolled_back');
    assert.equal(states['new-app'], 'never_deployed');
    assert.equal(states['cloud-app'], 'failed');

    assert.equal(data.deployments.last24Hours.SUCCESS, 1);
    assert.equal(data.deployments.last24Hours.FAILED, 7);
    assert.equal(data.deployments.last24Hours.ROLLBACK_FAILED, 1);
    assert.equal(data.deployments.rollbacksLast24Hours, 5);
    assert.equal(data.deployments.recentFailures[0].project_name, 'rolled-back-app');
    assert.ok(data.deployments.recentFailures.length <= 10);

    const ids = alertIds(data);
    for (const id of ['HIGH_FAILURE_RATE', 'ROLLBACK_FAILED', 'REPEATED_ROLLBACK', 'HEALTH_CHECK_FAILURES', 'AWS_DEPLOYMENT_FAILURES']) {
      assert.ok(ids.includes(id), `${id} in ${ids}`);
    }
    const repeated = data.alerts.find((alert) => alert.id === 'REPEATED_ROLLBACK');
    assert.match(repeated.message, /^flaky-app was rolled back 3 times in the last 24 hours$/);
  });

  test("another user sees none of it: only its own deployments, and the shared infrastructure", async () => {
    const data = await overview(bob);
    assert.deepEqual(data.projects.list, []);
    assert.deepEqual(data.deployments.last24Hours, {});
    assert.deepEqual(data.deployments.recentFailures, []);
    const ids = alertIds(data);
    assert.ok(!ids.includes('HIGH_FAILURE_RATE') && !ids.includes('ROLLBACK_FAILED'));
    assert.ok(ids.includes('WORKER_UNAVAILABLE'), 'infrastructure alerts are for everyone');
  });

  test('deployments that stopped progressing are flagged', async () => {
    const project = (await alice.post('/api/projects', projectPayload())).body.data;
    await insertDeployment(project.id, 'BUILDING', { minutesAgo: config.alerts.stuckAfterMinutes + 5 });
    const data = await overview(alice);
    assert.ok(data.deployments.stuck >= 1);
    assert.ok(alertIds(data).includes('STUCK_DEPLOYMENTS'));
    const metrics = await (await fetch(`${api.baseUrl}/metrics`)).text();
    assert.match(metrics, /deployx_deployments_stuck\{service="deployx-api"\} [1-9]/);
  });

  test('only signed-in users can read it', async () => {
    assert.equal((await api.anonymous.get('/api/monitoring/overview')).status, 401);
  });
});

describe('alert rules', () => {
  test('dependency outages are critical alerts', () => {
    const alerts = evaluateAlerts({ dependencies: { postgres: false, redis: false }, workers: null, queue: null, facts: null });
    assert.deepEqual(alerts.map((alert) => [alert.id, alert.severity]), [
      ['POSTGRES_UNAVAILABLE', 'critical'],
      ['REDIS_UNAVAILABLE', 'critical'],
    ]);
  });

  test('a low failure count does not trip the failure rate', () => {
    const facts = {
      outcomes: { day: { FAILED: 2 }, hour: { FAILED: 2 }, healthCheckFailuresHour: 0, awsFailuresHour: 0 },
      rollbacksByProject: [],
      stuck: 0,
    };
    const alerts = evaluateAlerts({ dependencies: { postgres: true, redis: true }, workers: [{ status: 'running' }], queue: { depth: 0 }, facts });
    assert.deepEqual(alerts, []);
  });
});
