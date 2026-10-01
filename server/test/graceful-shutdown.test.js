// Graceful shutdown of the API (lib/shutdown.js) on a real HTTP server, and
// the periodic removal of expired sessions.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openLogStream, pool, projectPayload, setupTestServer, waitFor } from './helpers.js';
import app from '../src/app.js';
import { closeAllLogStreams } from '../src/controllers/logStream.controller.js';
import { isShuttingDown, resetLifecycle } from '../src/lib/lifecycle.js';
import { createShutdown } from '../src/lib/shutdown.js';
import { startSessionCleanup } from '../src/services/session.service.js';

let api;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

async function listen() {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('API graceful shutdown', () => {
  test('stops taking requests, lets running ones finish, ends streams, then closes everything in order', async (t) => {
    t.after(resetLifecycle);
    const { server, baseUrl } = await listen();
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;
    const stream = await openLogStream(baseUrl, deployment.id);
    await stream.waitFor((event) => event.event === 'status');

    // A request that is still running when the shutdown starts.
    const original = pool.query.bind(pool);
    t.mock.method(pool, 'query', async (...args) => {
      if (/FROM projects WHERE \$2::boolean/.test(args[0])) await sleep(400);
      return original(...args);
    });
    const inFlight = fetch(`${baseUrl}/api/projects`, { headers: { cookie: api.cookie } });
    await sleep(100);

    const steps = [];
    let exitCode = null;
    const shutdown = createShutdown({
      server,
      timeoutMs: 5000,
      stopTimers: () => steps.push('timers'),
      closeStreams: () => {
        steps.push('streams');
        closeAllLogStreams();
      },
      closeSubscriber: async () => steps.push('subscriber'),
      closeQueue: async () => steps.push('queue'),
      closeConnections: async () => steps.push('connections'),
      exit: (code) => {
        exitCode = code;
      },
    });
    const done = shutdown('SIGTERM');

    // 1. Not ready any more.
    assert.equal(isShuttingDown(), true);
    // 2. New connections are refused.
    await assert.rejects(fetch(`${baseUrl}/health`));
    // 3. Live streams end; browsers reconnect elsewhere.
    await waitFor(() => stream.ended, { timeout: 2000 });
    // 4. The running request still gets its answer.
    const response = await inFlight;
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).data));

    await done;
    assert.deepEqual(steps, ['timers', 'streams', 'subscriber', 'queue', 'connections']);
    assert.equal(exitCode, 0);
    // A second signal does not start a second shutdown.
    assert.equal(shutdown('SIGINT'), done);
  });

  test('exits with an error if running requests do not finish in time', async (t) => {
    t.after(resetLifecycle);
    const { server, baseUrl } = await listen();
    const original = pool.query.bind(pool);
    t.mock.method(pool, 'query', async (...args) => {
      if (/FROM projects WHERE \$2::boolean/.test(args[0])) await sleep(1500);
      return original(...args);
    });
    const controller = new AbortController();
    const hanging = fetch(`${baseUrl}/api/projects`, { headers: { cookie: api.cookie }, signal: controller.signal }).catch(() => {});
    await sleep(100);

    const codes = [];
    createShutdown({ server, timeoutMs: 200, exit: (code) => codes.push(code) })('SIGTERM');
    await waitFor(() => codes.length > 0, { timeout: 2000 });
    assert.deepEqual(codes, [1]);
    controller.abort();
    await hanging;
    server.closeAllConnections();
  });
});

describe('session cleanup', () => {
  test('expired and idle sessions are removed on a schedule; live ones stay', async () => {
    const user = await api.clientFor({ email: 'cleanup@example.com' });
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at) VALUES
         ($1, $2, now() - interval '3 days', now() - interval '3 days', now() - interval '2 days'),
         ($1, $3, now() - interval '2 hours', now() - interval '2 hours', now() + interval '5 hours')`,
      [user.user.id, Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    );
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [user.user.id])).rows[0].n;
    assert.equal(await count(), 3);

    const cleanup = startSessionCleanup(50);
    try {
      await waitFor(async () => (await count()) === 1, { timeout: 3000 });
    } finally {
      cleanup.stop();
    }
    assert.equal((await user.get('/api/auth/me')).status, 200, 'the live session still works');
  });
});
