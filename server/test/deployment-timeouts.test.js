// Bounded deployments: the overall DEPLOYMENT_TIMEOUT_MS, how it stops running
// work but lets cleanup run, and the recovery of deployments whose job was
// lost. The real worker runs in this process against the test database.
import assert from 'node:assert/strict';
import { after, before, describe, mock, test } from 'node:test';
import { createFakePipeline } from './fakePipeline.js';
import { getDeploymentQueue, pool, projectPayload, setupTestServer, waitFor } from './helpers.js';

let api;
let project;
let worker;
let processor;
let exec;
let jobContext;
let healthChecks;
let recovery;
let awsErrors;
let workerPool;

before(async () => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  api = await setupTestServer();
  worker = await import('../../worker/src/worker.js');
  processor = await import('../../worker/src/processors/deploymentProcessor.js');
  exec = await import('../../worker/src/lib/exec.js');
  jobContext = await import('../../worker/src/lib/jobContext.js');
  healthChecks = await import('../../worker/src/services/healthCheckService.js');
  recovery = await import('../../worker/src/services/recoveryService.js');
  awsErrors = await import('../../worker/src/lib/awsErrors.js');
  workerPool = (await import('../../worker/src/db/postgres.js')).default;
  project = (await api.post('/api/projects', projectPayload())).body.data;
});

after(async () => {
  await api.close();
  await workerPool.end();
  mock.restoreAll();
});

const SLEEP_SCRIPT = 'setTimeout(() => {}, 60000)';

async function deploymentRow(id) {
  return (await pool.query('SELECT * FROM deployments WHERE id = $1', [id])).rows[0];
}

async function logs(id) {
  const { rows } = await pool.query('SELECT message FROM deployment_logs WHERE deployment_id = $1 ORDER BY id', [id]);
  return rows.map((row) => row.message);
}

async function deployWith(pipeline, options) {
  const running = worker.createDeploymentWorker({
    concurrency: 1,
    processor: processor.createDeploymentProcessor({ pipeline, ...options }),
  });
  const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;
  return { running, deployment };
}

describe('DEPLOYMENT_TIMEOUT_MS', () => {
  test('a command still running when the deployment times out is killed; FAILED at once, no retry', async () => {
    let killedAfterMs = null;
    const pipeline = async (ctx) => {
      await ctx.setStage('BUILDING', 'Deployment is now building');
      const started = Date.now();
      try {
        await exec.runCommand(process.execPath, ['-e', SLEEP_SCRIPT], { timeoutMs: 60000 });
      } finally {
        killedAfterMs = Date.now() - started;
      }
    };
    const { running, deployment } = await deployWith(pipeline, { timeoutMs: 400 });
    try {
      const row = await waitFor(async () => {
        const current = await deploymentRow(deployment.id);
        return current.status === 'FAILED' ? current : null;
      }, { timeout: 10000 });
      assert.ok(killedAfterMs < 5000, `the command ran ${killedAfterMs}ms`);
      assert.match(row.error_message, /^Deployment timed out after 0\.4s: .* was stopped: the deployment timed out$/);
      const messages = await logs(deployment.id);
      assert.ok(messages.some((line) => /Deployment timed out after .* \(DEPLOYMENT_TIMEOUT_MS\); stopping it/.test(line)));
      assert.equal(messages.filter((line) => line.startsWith('Deployment job started')).length, 1, 'not retried');
      assert.ok(messages.includes('Deployment failed and will not be retried'));
    } finally {
      await running.close();
    }
  });

  test('a pipeline that ignores the timeout is abandoned after the grace period', async () => {
    const pipeline = async (ctx) => {
      await ctx.setStage('BUILDING', 'Deployment is now building');
      await new Promise(() => {}); // never settles
    };
    const { running, deployment } = await deployWith(pipeline, { timeoutMs: 300, timeoutGraceMs: 300 });
    try {
      const row = await waitFor(async () => {
        const current = await deploymentRow(deployment.id);
        return current.status === 'FAILED' ? current : null;
      }, { timeout: 10000 });
      assert.match(row.error_message, /^Deployment timed out after 0\.3s; it did not stop within 0\.3s$/);
    } finally {
      await running.close();
    }
  });

  test('a deployment within its time is not affected', async () => {
    const { running, deployment } = await deployWith(createFakePipeline({ stepMs: 50 }), { timeoutMs: 5000 });
    try {
      await waitFor(async () => (await deploymentRow(deployment.id)).status === 'SUCCESS', { timeout: 10000 });
    } finally {
      await running.close();
    }
  });

  test('commands and health checks started after the timeout (cleanup, rollback) still run in full', async () => {
    const controller = new AbortController();
    controller.abort();
    await jobContext.runWithJobContext({ signal: controller.signal }, async () => {
      const result = await exec.runCommand(process.execPath, ['-e', 'process.stdout.write("cleaned up")'], { timeoutMs: 10000 });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'cleaned up');

      let attempts = 0;
      const health = await healthChecks.waitForHealthy({
        port: 1,
        path: '/health',
        retries: 2,
        interval: 1,
        startupGracePeriod: 0,
        check: async () => {
          attempts += 1;
          return attempts === 2 ? { healthy: true, statusCode: 200, responseTime: 1 } : { healthy: false, error: 'HTTP 503' };
        },
      });
      assert.equal(health.healthy, true);
    });
  });

  test('a health check running when the deployment times out stops early', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const result = await jobContext.runWithJobContext({ signal: controller.signal }, () =>
      healthChecks.waitForHealthy({
        port: 1,
        path: '/health',
        retries: 50,
        interval: 20,
        startupGracePeriod: 0,
        check: async () => {
          attempts += 1;
          if (attempts === 3) controller.abort();
          return { healthy: false, error: 'HTTP 503' };
        },
      }),
    );
    assert.equal(result.healthy, false);
    assert.equal(result.error, 'Deployment timed out during the health check');
    assert.equal(attempts, 3);
  });
});

describe('other bounds', () => {
  test('AWS SDK calls have connection and request timeouts', () => {
    const options = awsErrors.awsClientOptions();
    assert.ok(options.requestHandler.connectionTimeout > 0);
    assert.ok(options.requestHandler.requestTimeout > 0);
    assert.equal(options.maxAttempts, 3);
    assert.ok(!('credentials' in options), 'credentials come from the default chain');
  });

  test('PostgreSQL statements are bounded for the API and the worker', async () => {
    assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '15s');
    assert.equal((await workerPool.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s');
  });
});

describe('recovery of deployments without a job', () => {
  async function insertDeployment(status, { minutesAgo = 30, ...extra } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO deployments (project_id, branch, status, started_at, created_at, updated_at, rollback_deployment_id)
       VALUES ($1, 'main', $2::varchar, CASE WHEN $2::varchar = 'QUEUED' THEN NULL ELSE now() - make_interval(mins => $3) END,
               now() - make_interval(mins => $3), now() - make_interval(mins => $3), $4)
       RETURNING id`,
      [project.id, status, minutesAgo, extra.rollbackDeploymentId ?? null],
    );
    return rows[0].id;
  }

  test('ends stale unfinished deployments whose job is gone; leaves live and recent ones alone', async () => {
    const IORedis = (await import('ioredis')).default;
    const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
    const service = recovery.createRecoveryService({ connection: redis, staleAfterMs: 10 * 60 * 1000 });
    try {
      const lostBuilding = await insertDeployment('BUILDING');
      const lostQueued = await insertDeployment('QUEUED');
      const lostRollback = await insertDeployment('ROLLING_BACK');
      const recent = await insertDeployment('DEPLOYING', { minutesAgo: 1 });
      const waiting = await insertDeployment('QUEUED');
      await getDeploymentQueue().add('deploy', { deploymentId: waiting }, { jobId: waiting });
      // A job that was removed from the queue by hand.
      const removed = await insertDeployment('HEALTH_CHECK');
      const job = await getDeploymentQueue().add('deploy', { deploymentId: removed }, { jobId: removed });
      await job.remove();

      // Two workers checking at the same time: only one does the pass.
      const [first, second] = await Promise.all([service.recoverStuckDeployments(), service.recoverStuckDeployments()]);
      const result = first ?? second;
      assert.ok(first === null || second === null, 'one pass at a time');
      const ended = new Set(result.map((entry) => entry.id));
      assert.ok(ended.has(lostBuilding) && ended.has(lostQueued) && ended.has(lostRollback) && ended.has(removed));
      assert.ok(!ended.has(recent), 'recently changed deployments are left alone');
      assert.ok(!ended.has(waiting), 'a deployment whose job is waiting is genuinely queued');

      const building = await deploymentRow(lostBuilding);
      assert.equal(building.status, 'FAILED');
      assert.match(building.error_message, /stopped making progress in BUILDING: its job is no longer in the queue/);
      assert.ok(building.finished_at);
      assert.ok((await logs(lostBuilding)).some((line) => line.startsWith('Deployment marked FAILED by the recovery check')));

      const rolledBack = await deploymentRow(lostRollback);
      assert.equal(rolledBack.status, 'ROLLBACK_FAILED');
      assert.equal(rolledBack.rollback_status, 'FAILED');

      assert.equal((await deploymentRow(recent)).status, 'DEPLOYING');
      assert.equal((await deploymentRow(waiting)).status, 'QUEUED');

      // A second pass finds nothing more to do.
      const again = await service.recoverStuckDeployments();
      assert.ok(!again.some((entry) => [lostBuilding, lostQueued, lostRollback].includes(entry.id)));
    } finally {
      await service.stop();
      await redis.quit();
    }
  });
});
