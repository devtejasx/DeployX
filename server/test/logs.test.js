import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, projectPayload, setupTestServer } from './helpers.js';

let api;
let deployment;

before(async () => {
  api = await setupTestServer();
  const project = await api.post('/api/projects', projectPayload());
  const created = await api.post(`/api/projects/${project.body.data.id}/deployments`, {});
  deployment = created.body.data;
});

after(() => api.close());

describe('deployment logs', () => {
  test('stores log lines and returns them in chronological order', async () => {
    const lines = [
      { level: 'INFO', message: 'Deployment created' },
      { level: 'WARN', message: '  indented output is kept verbatim' },
      { level: 'ERROR', message: 'Something failed' },
    ];

    for (const line of lines) {
      const { status, body } = await api.post(`/api/deployments/${deployment.id}/logs`, line);
      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.deployment_id, deployment.id);
      assert.equal(body.data.level, line.level);
      assert.equal(body.data.message, line.message);
    }

    const { status, body } = await api.get(`/api/deployments/${deployment.id}/logs`);
    assert.equal(status, 200);
    assert.deepEqual(
      body.data.map(({ level, message }) => ({ level, message })),
      lines,
    );
  });

  test('rejects invalid log levels and empty messages', async () => {
    const { status, body } = await api.post(`/api/deployments/${deployment.id}/logs`, {
      level: 'DEBUG',
      message: '   ',
    });
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, [
      'Log level must be one of: INFO, WARN, ERROR',
      'Log message must not be empty',
    ]);

    const missing = await api.post(`/api/deployments/${deployment.id}/logs`, {});
    assert.deepEqual(missing.body.error.details, ['Log level is required', 'Log message is required']);

    const tooLong = await api.post(`/api/deployments/${deployment.id}/logs`, {
      level: 'INFO',
      message: 'x'.repeat(10001),
    });
    assert.deepEqual(tooLong.body.error.details, ['Log message must be at most 10000 characters']);
  });

  test('returns 404 for a deployment that does not exist', async () => {
    const add = await api.post(`/api/deployments/${MISSING_ID}/logs`, { level: 'INFO', message: 'hi' });
    assert.equal(add.status, 404);
    assert.equal(add.body.error.message, 'Deployment not found');

    const list = await api.get(`/api/deployments/${MISSING_ID}/logs`);
    assert.equal(list.status, 404);
  });

  test('returns 400 for a malformed deployment ID', async () => {
    const { status, body } = await api.get('/api/deployments/42/logs');
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, ['Invalid deployment ID']);
  });
});
