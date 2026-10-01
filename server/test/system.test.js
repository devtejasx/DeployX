import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setupTestServer } from './helpers.js';
import { connectRedis, pingRedis } from '../src/db/redis.js';

let api;

before(async () => {
  api = await setupTestServer();
  connectRedis();
  // Give the Redis client a moment to connect.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await pingRedis();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

after(() => api.close());

test('GET /api/health reports the API is up', async () => {
  const { status, body } = await api.get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.service, 'deployx-api');
});

test('GET /api/system/status checks PostgreSQL and Redis', async () => {
  const { status, body } = await api.get('/api/system/status');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    { api: body.data.api, database: body.data.database, redis: body.data.redis },
    { api: 'connected', database: 'connected', redis: 'connected' },
  );
});

test('unknown routes return 404 in the standard error format', async () => {
  const { status, body } = await api.get('/api/does-not-exist');
  assert.equal(status, 404);
  assert.deepEqual(body, { success: false, error: { code: 'NOT_FOUND', message: 'Route not found: GET /api/does-not-exist' } });
});

test('malformed JSON returns 400', async () => {
  const { status, body } = await api.post('/api/projects', undefined, { rawBody: '{"name": ' });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.message, 'Malformed JSON in request body');
});
