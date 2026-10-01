// Observability of the API: request IDs, structured logs without secrets,
// liveness/readiness, and Prometheus metrics.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TEST_PASSWORD, pool, projectPayload, setupTestServer } from './helpers.js';
import config from '../src/config/index.js';
import { beginShutdown, resetLifecycle } from '../src/lib/lifecycle.js';
import { createLogger, redact, scrubString } from '../src/lib/logger.js';

let api;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

// Captures every console line written while `fn` runs.
async function captureLogs(t, fn) {
  const lines = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
  }
  await fn();
  // Request lines are written when the response finishes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const method of ['log', 'warn', 'error']) console[method].mock.restore();
  return lines;
}

function jsonLines(lines) {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function metricsText(headers = {}) {
  const response = await fetch(`${api.baseUrl}/metrics`, { headers });
  return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
}

describe('request IDs', () => {
  test('every response carries one; a valid incoming ID is kept, anything else replaced', async () => {
    const generated = await api.get('/api/projects');
    assert.match(generated.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    const kept = await api.get('/api/projects', { headers: { 'x-request-id': 'trace-abc-12345' } });
    assert.equal(kept.headers.get('x-request-id'), 'trace-abc-12345');
    const replaced = await api.get('/api/projects', { headers: { 'x-request-id': 'bad id\twith "quotes"' } });
    assert.match(replaced.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });
});

describe('structured logs', () => {
  test('requests are logged as JSON with route, status, duration, user and request ID', async (t) => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const lines = await captureLogs(t, () => api.get(`/api/projects/${project.id}`, { headers: { 'x-request-id': 'req-for-log-test' } }));
    const entry = jsonLines(lines).find((line) => line.event === 'http_request' && line.requestId === 'req-for-log-test');
    assert.ok(entry, lines.join('\n'));
    assert.equal(entry.level, 'info');
    assert.equal(entry.service, 'deployx-api');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.route, '/api/projects/:id');
    assert.equal(entry.path, `/api/projects/${project.id}`);
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(entry.userId);
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
  });

  test('deployments are logged with their IDs', async (t) => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    let deployment;
    const lines = await captureLogs(t, async () => {
      deployment = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
    });
    const entry = jsonLines(lines).find((line) => line.event === 'deployment_queued');
    assert.deepEqual(
      { deploymentId: entry.deploymentId, projectId: entry.projectId, jobId: entry.jobId, trigger: entry.trigger },
      { deploymentId: deployment.id, projectId: project.id, jobId: deployment.id, trigger: 'MANUAL' },
    );
  });

  test('passwords, session tokens and cookies never appear in the logs', async (t) => {
    let cookie;
    const lines = await captureLogs(t, async () => {
      await api.anonymous.post('/api/auth/login', { email: 'admin@deployx.test', password: 'a wrong password here' });
      const response = await fetch(`${api.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer abcdefghijklmnop' },
        body: JSON.stringify({ email: 'admin@deployx.test', password: TEST_PASSWORD }),
      });
      cookie = response.headers.getSetCookie()[0].split(';')[0];
      await api.anonymous.get('/api/projects', { headers: { cookie } });
    });
    const output = lines.join('\n');
    assert.ok(jsonLines(lines).some((line) => line.event === 'login_failed'));
    for (const secret of [TEST_PASSWORD, 'a wrong password here', cookie.split('=')[1], 'abcdefghijklmnop']) {
      assert.ok(!output.includes(secret), `leaked ${secret}`);
    }
  });

  test('the logger redacts sensitive keys and scrubs credentials out of any string', () => {
    const safe = redact({
      password: 'hunter2hunter2',
      githubToken: 'abc',
      headers: { Authorization: 'Bearer xyz', cookie: 'deployx_session=abc' },
      awsSecretAccessKey: 'wJalrXUtnFEMI',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
      nested: { list: [{ secret: 's' }] },
      fine: 'visible',
    });
    assert.deepEqual(safe, {
      password: '[REDACTED]',
      githubToken: '[REDACTED]',
      headers: { Authorization: '[REDACTED]', cookie: '[REDACTED]' },
      awsSecretAccessKey: '[REDACTED]',
      privateKey: '[REDACTED]',
      nested: { list: [{ secret: '[REDACTED]' }] },
      fine: 'visible',
    });

    const scrubbed = scrubString(
      'clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r failed; ' +
        'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig; key AKIAABCDEFGHIJKLMNOP; ' +
        'token ghp_abcdefghijklmnopqrstuvwxyz0123456789; ' +
        'postgresql://deployx:s3cret@db:5432/deployx; -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
    );
    for (const secret of ['ghs_abcdef', 'eyJhbGci', 'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdef', 's3cret', 'MIIabc']) {
      assert.ok(!scrubbed.includes(secret), `${secret} in ${scrubbed}`);
    }
    assert.match(scrubbed, /https:\/\/\*\*\*@github\.com\/o\/r/);

    const err = new Error('connect to redis://:topsecret@redis:6379 failed');
    const serialized = redact({ err }).err;
    assert.equal(serialized.message, 'connect to redis://***@redis:6379 failed');
    assert.ok(!serialized.stack.includes('topsecret'));
  });

  test('levels filter output; pretty format is one readable line', (t) => {
    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(line));
    t.mock.method(console, 'warn', (line) => lines.push(line));
    const quiet = createLogger({ service: 'x', level: 'warn' });
    quiet.info('hidden');
    quiet.warn('shown', { a: 1 });
    createLogger({ service: 'x', level: 'silent' }).warn('never');
    createLogger({ service: 'svc', format: 'pretty' }).child({ jobId: '7' }).info('job_done', { msg: 'ok', durationMs: 5 });
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).event, 'shown');
    assert.match(lines[1], /^\S+ INFO  \[svc\] job_done - ok jobId=7 durationMs=5$/);
  });
});

describe('health endpoints', () => {
  test('liveness and readiness answer when everything is up', async () => {
    for (const path of ['/health', '/api/health']) {
      const response = await api.anonymous.get(path);
      assert.equal(response.status, 200);
      assert.equal(response.body.data.status, 'ok');
    }
    for (const path of ['/ready', '/api/ready']) {
      const response = await api.anonymous.get(path);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.data.checks, { postgres: 'ok', redis: 'ok', shutdown: 'no' });
    }
  });

  test('a database outage makes the API not ready, but it stays alive', async (t) => {
    t.mock.method(pool, 'query', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password authentication failed');
    });
    t.mock.method(console, 'error', () => {});
    assert.equal((await api.anonymous.get('/health')).status, 200);
    const ready = await api.anonymous.get('/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.data.checks.postgres, 'unavailable');
    assert.ok(!JSON.stringify(ready.body).includes('ECONNREFUSED'), 'no connection details');
  });

  test('a shutdown in progress makes the API not ready', async (t) => {
    t.after(resetLifecycle);
    beginShutdown();
    const ready = await api.anonymous.get('/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.data.checks.shutdown, 'in_progress');
    assert.equal((await api.anonymous.get('/health')).status, 200);
  });
});

describe('metrics', () => {
  test('Prometheus text with HTTP, deployment, queue and dependency metrics', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    await api.post(`/api/projects/${project.id}/deployments`, {});
    await api.get(`/api/projects/${project.id}`);
    await api.anonymous.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!' });

    const { status, type, text } = await metricsText();
    assert.equal(status, 200);
    assert.match(type, /^text\/plain/);
    assert.match(text, /deployx_http_request_duration_seconds_bucket\{.*route="\/api\/projects\/:id".*\}/);
    assert.ok(!text.includes(project.id), 'concrete IDs never become labels');
    assert.match(text, /deployx_deployments_total\{trigger="MANUAL",target="LOCAL",service="deployx-api"\} [1-9]/);
    assert.match(text, /deployx_deployments_in_progress\{status="QUEUED",service="deployx-api"\} [1-9]/);
    assert.match(text, /deployx_queue_depth\{service="deployx-api"\} \d+/);
    assert.match(text, /deployx_queue_jobs\{state="waiting",service="deployx-api"\} \d+/);
    assert.match(text, /deployx_dependency_up\{dependency="postgres",service="deployx-api"\} 1/);
    assert.match(text, /deployx_dependency_up\{dependency="redis",service="deployx-api"\} 1/);
    assert.match(text, /deployx_login_failures_total\{service="deployx-api"\} [1-9]/);
    assert.match(text, /deployx_api_process_cpu_seconds_total/);
  });

  test('5xx responses are counted as errors', async (t) => {
    t.mock.method(pool, 'query', async () => {
      throw new Error('boom');
    });
    t.mock.method(console, 'error', () => {});
    assert.equal((await api.get('/api/projects')).status, 500);
    t.mock.restoreAll();
    const { text } = await metricsText();
    assert.match(text, /deployx_http_request_errors_total\{method="GET",route="unmatched",status_code="500",service="deployx-api"\} [1-9]|deployx_http_request_errors_total\{method="GET",route="\/api\/projects",status_code="500",service="deployx-api"\} [1-9]/);
  });

  test('METRICS_TOKEN protects the endpoint; production without a token disables it', async (t) => {
    t.after(() => {
      config.metrics.token = '';
      config.env = 'test';
    });
    config.metrics.token = 'scrape-token-123';
    assert.equal((await metricsText()).status, 401);
    assert.equal((await metricsText({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await metricsText({ authorization: 'Bearer scrape-token-123' })).status, 200);

    config.metrics.token = '';
    config.env = 'production';
    assert.equal((await metricsText()).status, 404);
  });
});
