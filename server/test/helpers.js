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

const { default: app } = await import('../src/app.js');
const { default: pool, closePostgres } = await import('../src/db/postgres.js');
const { connectRedis, closeRedis } = await import('../src/db/redis.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { getDeploymentQueue, closeDeploymentQueue } = await import('../src/queues/deploymentQueue.js');

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

// Creates + migrates the test database, empties it and the test queue, and
// starts the API on a random port. Returns a small fetch-based client.
export async function setupTestServer() {
  await ensureTestDatabase();
  await runMigrations({ databaseUrl: testDatabaseUrl, log: () => {} });
  await pool.query('TRUNCATE users, projects, deployments, deployment_logs RESTART IDENTITY CASCADE');

  connectRedis();
  await getDeploymentQueue().obliterate({ force: true });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, body, { rawBody } = {}) {
    const init = { method, headers: {} };
    if (rawBody !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = rawBody;
    } else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${urlPath}`, init);
    return { status: response.status, body: await response.json() };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await closeDeploymentQueue();
    await Promise.allSettled([closePostgres(), closeRedis()]);
  }

  return {
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body, options) => request('POST', urlPath, body, options),
    put: (urlPath, body) => request('PUT', urlPath, body),
    patch: (urlPath, body) => request('PATCH', urlPath, body),
    delete: (urlPath) => request('DELETE', urlPath),
    close,
  };
}

export const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let projectCounter = 0;

export function projectPayload(overrides = {}) {
  projectCounter += 1;
  return {
    name: `Test project ${projectCounter}`,
    description: 'Integration test project',
    github_repo: 'https://github.com/example/my-api',
    github_branch: 'main',
    dockerfile_path: 'Dockerfile',
    ...overrides,
  };
}
