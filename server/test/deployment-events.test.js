// Real-time deployment events published by the API over Redis Pub/Sub.
// (Events published by the worker are covered in queue-worker.test.js.)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { projectPayload, recordDeploymentEvents, setupTestServer } from './helpers.js';

let api;
let recorder;
let project;

before(async () => {
  api = await setupTestServer();
  recorder = await recordDeploymentEvents();
  project = (await api.post('/api/projects', projectPayload())).body.data;
});

after(async () => {
  await recorder.close();
  await api.close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function createDeployment() {
  return (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
}

test('persisted log lines are published on the deployment channel with their database id', async () => {
  const deployment = await createDeployment();
  const { body } = await api.post(`/api/deployments/${deployment.id}/logs`, { level: 'WARN', message: 'hello' });
  await settle();

  const events = recorder.forDeployment(deployment.id);
  assert.deepEqual(
    events.map((event) => [event.type, event.log?.message]),
    [
      ['log', 'Deployment created'],
      ['log', 'hello'],
    ],
  );
  assert.equal(events[1].log.id, body.data.id);
  assert.equal(events[1].log.level, 'WARN');

  const channels = new Set(recorder.events.filter((e) => e.event.deploymentId === deployment.id).map((e) => e.channel));
  assert.deepEqual([...channels], [`deployx-test:deployment:${deployment.id}:events`]);
});

test('status changes are published, and a no-op change is not', async () => {
  const deployment = await createDeployment();
  await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'BUILDING' });
  await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'BUILDING' });
  await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'SUCCESS' }); // rejected (409)
  await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'FAILED' });
  await settle();

  const statuses = recorder.forDeployment(deployment.id).filter((e) => e.type === 'status').map((e) => e.status);
  assert.deepEqual(statuses, ['BUILDING', 'FAILED']);
});

test("events of one deployment never appear on another deployment's channel", async () => {
  const a = await createDeployment();
  const b = await createDeployment();
  await api.post(`/api/deployments/${a.id}/logs`, { level: 'INFO', message: 'only for A' });
  await settle();

  for (const { channel, event } of recorder.events) {
    assert.equal(channel, `deployx-test:deployment:${event.deploymentId}:events`);
  }
  assert.ok(!recorder.forDeployment(b.id).some((event) => event.log?.message === 'only for A'));
});

test('a Redis outage does not fail the request that produced the event', async (t) => {
  const { default: redisConnection } = await import('../src/db/redis.js');
  t.mock.method(redisConnection, 'publish', async () => {
    throw new Error('Connection is closed.');
  });
  t.mock.method(console, 'warn', () => {});

  const deployment = await createDeployment();
  const { status } = await api.post(`/api/deployments/${deployment.id}/logs`, { level: 'INFO', message: 'still stored' });
  assert.equal(status, 201);
  const logs = await api.get(`/api/deployments/${deployment.id}/logs`);
  assert.ok(logs.body.data.some((line) => line.message === 'still stored'));
});
