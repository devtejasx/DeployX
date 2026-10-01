// Shared setup for the API integration tests.
//
// The tests run against a real PostgreSQL database, a separate one from
// development: TEST_DATABASE_URL, or DATABASE_URL with "_test" appended to
// the database name. It is created and migrated automatically, and emptied
// before each test file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
try {
  process.loadEnvFile(rootEnvPath);
} catch {
  // No .env file - rely on the process environment.
}

function resolveTestDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL || 'postgresql://deployx:deployx@localhost:5432/deployx');
  url.pathname = `${url.pathname.slice(1)}_test`;
  return url.toString();
}

export const testDatabaseUrl = resolveTestDatabaseUrl();

// Must happen before the app (and its config) is loaded; variables that are
// already set are never overridden by the .env file.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
// Test jobs live under their own Redis key prefix, apart from development.
process.env.QUEUE_PREFIX = process.env.TEST_QUEUE_PREFIX || 'deployx-test';
// Short retry backoff (200ms, 400ms) so retry tests finish quickly.
process.env.DEPLOYMENT_JOB_BACKOFF_MS = '200';
// Cheap password hashes (2^12 instead of 2^17): tests create many accounts.
process.env.PASSWORD_HASH_COST ||= '12';
process.env.ALLOW_REGISTRATION ||= 'true';
// Rate limits out of the way, except where a test file sets its own
// (rate-limit.test.js).
for (const name of [
  'RATE_LIMIT_API_PER_MINUTE',
  'RATE_LIMIT_LOGIN_PER_15_MINUTES',
  'RATE_LIMIT_LOGIN_PER_EMAIL',
  'RATE_LIMIT_REGISTER_PER_HOUR',
  'RATE_LIMIT_WEBHOOKS_PER_MINUTE',
  'RATE_LIMIT_DEPLOYMENTS_PER_MINUTE',
  'RATE_LIMIT_PROJECTS_PER_HOUR',
]) {
  process.env[name] ||= '100000';
}

const { default: app } = await import('../src/app.js');
const { default: pool, closePostgres } = await import('../src/db/postgres.js');
const { default: redisConnection, connectRedis, closeRedis } = await import('../src/db/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { getDeploymentQueue, closeDeploymentQueue } = await import('../src/queues/deploymentQueue.js');
const { closeSubscriber } = await import('../src/events/deploymentSubscriber.js');
const { closeAllLogStreams } = await import('../src/controllers/logStream.controller.js');
const { upsertUser } = await import('../src/services/user.service.js');

export { pool, getDeploymentQueue };

async function ensureTestDatabase() {
  const url = new URL(testDatabaseUrl);
  const databaseName = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Refusing to create test database with unusual name: ${databaseName}`);
  }

  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (rowCount === 0) {
      // Identifiers cannot be parameterized; the name was checked above.
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await admin.end();
  }
}

// Every test signs in. The default client is an ADMIN (as the first account
// of an installation is); clientFor() adds other accounts.
export const TEST_PASSWORD = 'correct horse battery staple';
export const DEFAULT_USER = { name: 'Test Admin', email: 'admin@deployx.test', role: 'ADMIN' };

// Cookie of the default client, used by openLogStream() unless told otherwise.
let defaultCookie = null;

function sessionCookieFrom(response) {
  const header = response.headers.getSetCookie().find((cookie) => /deployx_session=/.test(cookie));
  return header ? header.split(';')[0] : null;
}

// Signs in through the API; returns the "name=value" session cookie.
export async function signIn(baseUrl, email, password = TEST_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200) throw new Error(`Sign-in as ${email} failed with HTTP ${response.status}`);
  return sessionCookieFrom(response);
}

// Creates + migrates the test database, empties it and the test queue, and
// starts the API on a random port. Returns a small fetch-based client, signed
// in as DEFAULT_USER.
export async function setupTestServer() {
  await ensureTestDatabase();
  await runMigrations({ databaseUrl: testDatabaseUrl, log: () => {} });
  await pool.query('TRUNCATE users, projects, deployments, deployment_logs RESTART IDENTITY CASCADE');

  connectRedis();
  await getDeploymentQueue().obliterate({ force: true });
  // Rate-limit counters of earlier runs.
  const counters = await redisConnection.keys(`${process.env.QUEUE_PREFIX}:ratelimit:*`);
  if (counters.length > 0) await redisConnection.del(...counters);

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A client sending `cookie` (null: signed out) with every request.
  function makeClient(session) {
    async function request(method, urlPath, body, { rawBody, headers = {} } = {}) {
      const init = { method, headers: { ...headers } };
      if (session.cookie) init.headers.cookie = session.cookie;
      if (rawBody !== undefined) {
        init.headers['content-type'] ??= 'application/json';
        init.body = rawBody;
      } else if (body !== undefined) {
        init.headers['content-type'] ??= 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${baseUrl}${urlPath}`, init);
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, headers: response.headers };
    }
    return {
      baseUrl,
      get cookie() {
        return session.cookie;
      },
      request,
      get: (urlPath, options) => request('GET', urlPath, undefined, options),
      post: (urlPath, body, options) => request('POST', urlPath, body, options),
      put: (urlPath, body, options) => request('PUT', urlPath, body, options),
      patch: (urlPath, body, options) => request('PATCH', urlPath, body, options),
      delete: (urlPath, options) => request('DELETE', urlPath, undefined, options),
    };
  }

  // Creates (or resets) an account with TEST_PASSWORD and signs it in.
  async function clientFor({ name = 'Test User', email, role = 'USER' }) {
    const { user } = await upsertUser({ name, email, password: TEST_PASSWORD, role });
    const client = makeClient({ cookie: await signIn(baseUrl, email) });
    client.user = user;
    return client;
  }

  const main = { cookie: null };
  // (Re-)creates the default account and signs in again, e.g. after a test
  // reverted the migration that holds sessions.
  async function relogin() {
    await upsertUser({ ...DEFAULT_USER, password: TEST_PASSWORD });
    main.cookie = await signIn(baseUrl, DEFAULT_USER.email);
    defaultCookie = main.cookie;
  }
  await relogin();

  async function close() {
    closeAllLogStreams();
    await new Promise((resolve) => server.close(resolve));
    await closeSubscriber();
    await closeDeploymentQueue();
    await Promise.allSettled([closePostgres(), closeRedis()]);
  }

  return {
    ...makeClient(main),
    anonymous: makeClient({ cookie: null }),
    clientFor,
    relogin,
    close,
  };
}

export const MISSING_ID = '00000000-0000-4000-8000-000000000000';

// Records every deployment event published on the test queue prefix:
// [{ channel, event }]. Uses its own Redis connection (subscriber mode).
export async function recordDeploymentEvents() {
  const { default: IORedis } = await import('ioredis');
  const subscriber = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
  const events = [];
  subscriber.on('pmessage', (pattern, channel, message) => {
    events.push({ channel, event: JSON.parse(message) });
  });
  await subscriber.psubscribe(`${process.env.QUEUE_PREFIX}:deployment:*:events`);
  return {
    events,
    forDeployment: (deploymentId) => events.filter((e) => e.event.deploymentId === deploymentId).map((e) => e.event),
    close: () => subscriber.quit(),
  };
}

export async function waitFor(check, { timeout = 5000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Opens the SSE log stream of a deployment and parses its events:
// [{ event, id, data }].
export async function openLogStream(baseUrl, deploymentId, { lastEventId, cookie = defaultCookie } = {}) {
  const controller = new AbortController();
  const headers = lastEventId ? { 'Last-Event-ID': lastEventId } : {};
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}/api/deployments/${deploymentId}/logs/stream`, {
    headers,
    signal: controller.signal,
  });
  const stream = { response, events: [], ended: false, comments: 0 };
  if (!response.headers.get('content-type')?.startsWith('text/event-stream')) return stream;

  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = {};
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) stream.comments += 1;
            else if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('id: ')) event.id = line.slice(4);
            else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
          }
          if (event.event) stream.events.push(event);
        }
      }
    } catch {
      // aborted by the test
    }
    stream.ended = true;
  })();

  stream.logs = () => stream.events.filter((e) => e.event === 'log').map((e) => e.data.message);
  stream.statuses = () => stream.events.filter((e) => e.event === 'status').map((e) => e.data.status);
  stream.waitFor = (predicate, options) => waitFor(() => stream.events.find(predicate), options);
  stream.close = () => controller.abort();
  return stream;
}

let projectCounter = 0;

export function projectPayload(overrides = {}) {
  projectCounter += 1;
  return {
    name: `Test project ${projectCounter}`,
    description: 'Integration test project',
    github_repo: 'https://github.com/example/my-api',
    github_branch: 'main',
    dockerfile_path: 'Dockerfile',
    container_port: 3000,
    ...overrides,
  };
}
