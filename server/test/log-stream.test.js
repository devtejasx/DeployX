// GET /api/deployments/:deploymentId/logs/stream (Server-Sent Events).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, openLogStream, pool, projectPayload, setupTestServer, waitFor } from './helpers.js';

const { default: config } = await import('../src/config/index.js');
const { subscriptionStats } = await import('../src/events/deploymentSubscriber.js');

let api;
let project;

before(async () => {
  api = await setupTestServer();
  project = (await api.post('/api/projects', projectPayload())).body.data;
});

after(() => api.close());

const openStream = (deploymentId, options) => openLogStream(api.baseUrl, deploymentId, options);

async function createDeployment(target = project) {
  return (await api.post(`/api/projects/${target.id}/deployments`, {})).body.data.deployment;
}

const addLog = (deploymentId, message) => api.post(`/api/deployments/${deploymentId}/logs`, { level: 'INFO', message });
const setStatus = (deploymentId, status) => api.patch(`/api/deployments/${deploymentId}/status`, { status });

describe('opening a stream', () => {
  test('uses SSE headers and sends stored logs first, then the current status', async () => {
    const deployment = await createDeployment();
    await addLog(deployment.id, 'first');
    await addLog(deployment.id, 'second');

    const stream = await openStream(deployment.id);
    assert.equal(stream.response.status, 200);
    assert.equal(stream.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(stream.response.headers.get('cache-control'), 'no-cache, no-transform');

    await stream.waitFor((e) => e.event === 'status');
    assert.deepEqual(stream.events.map((e) => e.event), ['log', 'log', 'log', 'status']);
    assert.deepEqual(stream.logs(), ['Deployment created', 'first', 'second']);
    // Each log event carries its database id as the SSE event id.
    const ids = stream.events.filter((e) => e.event === 'log').map((e) => e.id);
    assert.deepEqual(ids, stream.events.filter((e) => e.event === 'log').map((e) => e.data.id));
    assert.equal(stream.events.at(-1).data.status, 'QUEUED');
    assert.equal(stream.events.at(-1).data.id, deployment.id);
    stream.close();
  });

  test('unknown and malformed deployment IDs get normal JSON errors, not a stream', async () => {
    const missing = await fetch(`${api.baseUrl}/api/deployments/${MISSING_ID}/logs/stream`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { success: false, error: { message: 'Deployment not found' } });

    const malformed = await fetch(`${api.baseUrl}/api/deployments/nope/logs/stream`);
    assert.equal(malformed.status, 400);
  });
});

describe('live updates', () => {
  test('new log lines and status changes are streamed as they happen', async () => {
    // Long poll interval: anything arriving quickly came through Redis.
    config.logStream.pollMs = 60000;
    const deployment = await createDeployment();
    const stream = await openStream(deployment.id);
    await stream.waitFor((e) => e.event === 'status');
    try {
      await addLog(deployment.id, 'Cloning repository...');
      await stream.waitFor((e) => e.data?.message === 'Cloning repository...', { timeout: 1500 });
      await setStatus(deployment.id, 'BUILDING');
      await stream.waitFor((e) => e.event === 'status' && e.data.status === 'BUILDING', { timeout: 1500 });
    } finally {
      config.logStream.pollMs = 2000;
    }
    stream.close();
  });

  test('the stream closes after SUCCESS', async () => {
    const deployment = await createDeployment();
    const stream = await openStream(deployment.id);
    await stream.waitFor((e) => e.event === 'status');

    await setStatus(deployment.id, 'BUILDING');
    await setStatus(deployment.id, 'DEPLOYING');
    await addLog(deployment.id, 'Container started');
    await setStatus(deployment.id, 'HEALTH_CHECK');
    await setStatus(deployment.id, 'SUCCESS');

    const end = await stream.waitFor((e) => e.event === 'end');
    assert.deepEqual(end.data, { deploymentId: deployment.id, status: 'SUCCESS' });
    await waitFor(() => stream.ended);
    assert.deepEqual(stream.statuses(), ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS']);
    assert.ok(stream.logs().includes('Container started'));
    assert.equal(stream.events.at(-1).event, 'end');
  });

  test('the stream closes after FAILED, with the error message in the final status', async () => {
    const deployment = await createDeployment();
    const stream = await openStream(deployment.id);
    await stream.waitFor((e) => e.event === 'status');

    await pool.query(`SELECT transition_deployment_status($1, 'FAILED', 'Docker build failed')`, [deployment.id]);
    // No event was published for that change: the periodic check picks it up.
    const end = await stream.waitFor((e) => e.event === 'end', { timeout: 5000 });
    assert.equal(end.data.status, 'FAILED');
    const finalStatus = stream.events.findLast((e) => e.event === 'status');
    assert.equal(finalStatus.data.error_message, 'Docker build failed');
    await waitFor(() => stream.ended);
  });

  test('the last log line, committed together with the final status, is streamed before the end', async (t) => {
    const deployment = await createDeployment();
    for (const status of ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK']) await setStatus(deployment.id, status);

    // The worker finishes right after the stream read the logs and before it
    // reads the deployment: status and last line in one statement, as the
    // worker writes them.
    const realQuery = pool.query.bind(pool);
    let finished = false;
    t.mock.method(pool, 'query', async (text, params) => {
      const result = await realQuery(text, params);
      if (!finished && typeof text === 'string' && text.includes('id > $2::bigint') && params?.[0] === deployment.id) {
        finished = true;
        await realQuery(
          `WITH updated AS (SELECT id FROM transition_deployment_status($1, 'FAILED', 'Health check failed'))
           INSERT INTO deployment_logs (deployment_id, level, message)
           SELECT id, 'ERROR', 'Deployment failed: the last line' FROM updated`,
          [deployment.id],
        );
      }
      return result;
    });

    const stream = await openStream(deployment.id);
    const end = await stream.waitFor((e) => e.event === 'end');
    assert.equal(end.data.status, 'FAILED');
    assert.equal(stream.logs().at(-1), 'Deployment failed: the last line');
    assert.deepEqual(stream.events.slice(-3).map((e) => e.event), ['log', 'status', 'end']);
  });

  test('the stream stays open through a rollback and closes after ROLLBACK_FAILED', async () => {
    const deployment = await createDeployment();
    const stream = await openStream(deployment.id);
    await stream.waitFor((e) => e.event === 'status');

    for (const status of ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK']) {
      await setStatus(deployment.id, status);
    }
    await stream.waitFor((e) => e.event === 'status' && e.data.status === 'ROLLING_BACK');
    await addLog(deployment.id, 'Rollback failed: the stable deployment is unhealthy too');
    assert.equal(stream.ended, false);

    await setStatus(deployment.id, 'ROLLBACK_FAILED');
    const end = await stream.waitFor((e) => e.event === 'end');
    assert.deepEqual(end.data, { deploymentId: deployment.id, status: 'ROLLBACK_FAILED' });
    await waitFor(() => stream.ended);
    assert.equal(stream.statuses().at(-1), 'ROLLBACK_FAILED');
    assert.ok(stream.logs().includes('Rollback failed: the stable deployment is unhealthy too'));
  });

  test('a change of the deployment record is pushed even when its status stays the same', async () => {
    config.logStream.pollMs = 100;
    try {
      const deployment = await createDeployment();
      for (const status of ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK']) await setStatus(deployment.id, status);
      const stream = await openStream(deployment.id);
      await stream.waitFor((e) => e.event === 'status' && e.data.status === 'HEALTH_CHECK');

      // As the worker does after each health-check attempt.
      const progress = { status: 'RUNNING', attempts: 2, max_attempts: 5, status_code: 503 };
      await pool.query('UPDATE deployments SET health_check = $2 WHERE id = $1', [deployment.id, progress]);

      const update = await stream.waitFor((e) => e.event === 'status' && e.data.health_check?.attempts === 2, {
        timeout: 2000,
      });
      assert.equal(update.data.status, 'HEALTH_CHECK');
      assert.deepEqual(update.data.health_check, progress);

      // Nothing changed since: no further status events.
      const sent = stream.statuses().length;
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(stream.statuses().length, sent);
      stream.close();
    } finally {
      config.logStream.pollMs = 2000;
    }
  });

  test('a deployment that is already finished gets its logs, status and end at once', async () => {
    const deployment = await createDeployment();
    await setStatus(deployment.id, 'FAILED');
    const stream = await openStream(deployment.id);
    await waitFor(() => stream.ended);
    assert.deepEqual(stream.events.map((e) => e.event), ['log', 'status', 'end']);
  });
});

describe('robustness', () => {
  test('without Redis events, new lines still arrive through the periodic check', async () => {
    config.logStream.pollMs = 200;
    try {
      const deployment = await createDeployment();
      const stream = await openStream(deployment.id);
      await stream.waitFor((e) => e.event === 'status');
      // Written straight to the database: nothing is published.
      await pool.query(`INSERT INTO deployment_logs (deployment_id, level, message) VALUES ($1, 'INFO', 'unpublished line')`, [
        deployment.id,
      ]);
      await stream.waitFor((e) => e.data?.message === 'unpublished line', { timeout: 2000 });
      stream.close();
    } finally {
      config.logStream.pollMs = 2000;
    }
  });

  test('reconnecting with Last-Event-ID resumes after the last line received, without duplicates', async () => {
    const deployment = await createDeployment();
    await addLog(deployment.id, 'one');
    await addLog(deployment.id, 'two');

    const first = await openStream(deployment.id);
    await first.waitFor((e) => e.event === 'status');
    const lastSeen = first.events.filter((e) => e.event === 'log').at(-1).id;
    first.close();

    await addLog(deployment.id, 'three'); // written while "disconnected"
    const second = await openStream(deployment.id, { lastEventId: lastSeen });
    await second.waitFor((e) => e.event === 'status');
    assert.deepEqual(second.logs(), ['three']);
    second.close();
  });

  test('logs of one deployment never appear in the stream of another', async () => {
    const a = await createDeployment();
    const b = await createDeployment();
    const streamA = await openStream(a.id);
    const streamB = await openStream(b.id);
    await streamA.waitFor((e) => e.event === 'status');
    await streamB.waitFor((e) => e.event === 'status');

    await addLog(b.id, 'only for B');
    await streamB.waitFor((e) => e.data?.message === 'only for B');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!streamA.logs().includes('only for B'));
    assert.ok(streamA.events.filter((e) => e.event === 'log').every((e) => e.data.deployment_id === a.id));
    streamA.close();
    streamB.close();
  });

  test('streams share one Redis subscription per deployment, released when clients disconnect', async () => {
    const deployment = await createDeployment();
    const channel = `deployx-test:deployment:${deployment.id}:events`;
    const baseline = subscriptionStats().listeners;

    const one = await openStream(deployment.id);
    const two = await openStream(deployment.id);
    await one.waitFor((e) => e.event === 'status');
    await two.waitFor((e) => e.event === 'status');
    assert.equal(subscriptionStats().channels.filter((c) => c === channel).length, 1);
    assert.equal(subscriptionStats().listeners, baseline + 2);

    one.close();
    two.close();
    await waitFor(() => !subscriptionStats().channels.includes(channel));
    assert.equal(subscriptionStats().listeners, baseline);
  });

  test('keep-alive comments are sent while the deployment is running', async () => {
    config.logStream.heartbeatMs = 100;
    try {
      const deployment = await createDeployment();
      const stream = await openStream(deployment.id);
      await waitFor(() => stream.comments >= 2);
      stream.close();
    } finally {
      config.logStream.heartbeatMs = 15000;
    }
  });
});
