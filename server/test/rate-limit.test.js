// Rate limits: sign-in, registration, webhooks, deployment and project
// creation, and the general API limit; shared through Redis, in memory when
// Redis is unavailable. Uses low limits (rateLimitEnv.js).
import './rateLimitEnv.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEST_PASSWORD, projectPayload, setupTestServer } from './helpers.js';
import { sign } from './githubWebhook.js';
import redisConnection from '../src/db/redis.js';
import { RedisFallbackStore } from '../src/middleware/rateLimit.js';

let api;
let carol;
let dave;

before(async () => {
  api = await setupTestServer();
  // Signed in before the sign-in tests block this address.
  carol = await api.clientFor({ email: 'carol@example.com' });
  dave = await api.clientFor({ email: 'dave@example.com' });
});

after(() => api.close());

function login(email, password) {
  return api.anonymous.post('/api/auth/login', { email, password });
}

function assertLimited(response) {
  assert.equal(response.status, 429);
  assert.equal(response.body.error.code, 'RATE_LIMITED');
  assert.match(response.body.error.message, /^Too many requests; try again in \d+ seconds$/);
  assert.ok(Number(response.headers.get('retry-after')) > 0, 'Retry-After');
  assert.match(response.headers.get('ratelimit') ?? '', /limit=\d+, remaining=0, reset=\d+/);
}

describe('sign-in', () => {
  test('correct sign-ins never count; failed ones are limited per account', async () => {
    const client = await api.clientFor({ email: 'limited@example.com' });
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await login('limited@example.com', TEST_PASSWORD)).status, 200, `sign-in ${i + 1}`);
    }

    assert.equal((await login('limited@example.com', 'wrong password 1')).status, 401);
    assert.equal((await login('limited@example.com', 'wrong password 2')).status, 401);
    assertLimited(await login('limited@example.com', 'wrong password 3'));
    // Even the right password waits: the account is under attack.
    assertLimited(await login('LIMITED@example.com', TEST_PASSWORD));
    // An existing session is unaffected.
    assert.equal((await client.get('/api/auth/me')).status, 200);
  });

  test('failed sign-ins are limited per address across accounts', async () => {
    // The four failed attempts above all came from this address: any account
    // tried from it now waits.
    assertLimited(await login('someone-else@example.com', 'nope nope nope'));
    const fresh = await api.anonymous.post('/api/auth/register', {
      name: 'Fresh',
      email: 'fresh@example.com',
      password: TEST_PASSWORD,
    });
    assert.equal(fresh.status, 201);
    assertLimited(await login('fresh@example.com', 'wrong wrong wrong'));
  });
});

describe('creation limits', () => {
  test('registration is limited per address', async () => {
    const register = (n) =>
      api.anonymous.post('/api/auth/register', { name: 'R', email: `reg-${n}@example.com`, password: TEST_PASSWORD });
    // One registration already happened above (fresh@example.com).
    assert.equal((await register(1)).status, 201);
    assertLimited(await register(2));
  });

  test('projects and deployments are limited per user, not per address', async () => {

    const projects = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await carol.post('/api/projects', projectPayload());
      assert.equal(response.status, 201);
      projects.push(response.body.data);
    }
    assertLimited(await carol.post('/api/projects', projectPayload()));
    assert.equal((await dave.post('/api/projects', projectPayload())).status, 201, 'another user is not affected');

    for (let i = 0; i < 3; i += 1) {
      assert.equal((await carol.post(`/api/projects/${projects[0].id}/deployments`, {})).status, 201);
    }
    assertLimited(await carol.post(`/api/projects/${projects[1].id}/deployments`, {}));
    // Reading is not affected by the creation limit.
    assert.equal((await carol.get(`/api/projects/${projects[0].id}/deployments`)).status, 200);
  });
});

describe('webhooks', () => {
  test('deliveries are limited per address, signed or not', async () => {
    const send = (signature) =>
      fetch(`${api.baseUrl}/api/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': signature },
        body: '{}',
      });
    const statuses = [];
    for (const signature of [sign('{}'), 'sha256=00', sign('{}'), sign('{}')]) {
      statuses.push((await send(signature)).status);
    }
    assert.deepEqual(statuses.slice(0, 3).map((status) => status !== 429), [true, true, true]);
    assert.equal(statuses[3], 429);
  });
});

describe('general API limit', () => {
  test('every /api request counts per address; liveness is never limited', async () => {
    let response;
    for (let i = 0; i < 200; i += 1) {
      response = await api.get('/api/auth/me');
      if (response.status === 429) break;
    }
    assertLimited(response);
    assert.equal((await api.get('/api/health')).status, 200);
  });
});

describe('the store', () => {
  test('counts in Redis, shared by every API instance', async () => {
    const one = new RedisFallbackStore('shared-test');
    const two = new RedisFallbackStore('shared-test');
    one.init({ windowMs: 60000 });
    two.init({ windowMs: 60000 });
    await one.resetKey('k');
    assert.equal((await one.increment('k')).totalHits, 1);
    assert.equal((await two.increment('k')).totalHits, 2);
    const { resetTime } = await one.increment('k');
    assert.ok(resetTime.getTime() > Date.now() && resetTime.getTime() <= Date.now() + 60000);
    assert.equal(await redisConnection.get(`${process.env.QUEUE_PREFIX}:ratelimit:shared-test:k`), '3');
    await one.decrement('k');
    assert.equal((await two.increment('k')).totalHits, 3);
  });

  test('falls back to memory when Redis is down or failing - never to "no limit"', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const down = new RedisFallbackStore('down', { redis: { status: 'reconnecting' } });
    down.init({ windowMs: 60000 });
    const hits = [];
    for (let i = 0; i < 3; i += 1) hits.push((await down.increment('ip')).totalHits);
    assert.deepEqual(hits, [1, 2, 3]);

    const failing = new RedisFallbackStore('failing', {
      redis: { status: 'ready', eval: async () => Promise.reject(new Error('READONLY')), decr: async () => 0, del: async () => 0 },
    });
    failing.init({ windowMs: 60000 });
    assert.equal((await failing.increment('ip')).totalHits, 1);
    assert.equal((await failing.increment('ip')).totalHits, 2);

    const hanging = new RedisFallbackStore('hanging', { redis: { status: 'ready', eval: () => new Promise(() => {}) } });
    hanging.init({ windowMs: 60000 });
    const started = Date.now();
    assert.equal((await hanging.increment('ip')).totalHits, 1);
    assert.ok(Date.now() - started < 2000, 'a hanging Redis does not hang requests');
  });
});
