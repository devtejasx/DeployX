// Unit tests for the worker's health-check service. They talk to small HTTP
// servers started in this process; no Docker or database needed.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, describe, test } from 'node:test';

// The worker reads its health-check settings from the environment once, when
// its configuration is loaded (below). Set here so the test does not depend
// on a developer's .env.
Object.assign(process.env, {
  HEALTH_CHECK_HOST: '127.0.0.1',
  HEALTH_CHECK_TIMEOUT_MS: '1500',
  HEALTH_CHECK_INTERVAL_MS: '250',
  HEALTH_CHECK_RETRIES: '4',
  HEALTH_CHECK_STARTUP_GRACE_MS: '0',
});

const { HEALTH_CHECK_PATH_PATTERN, HealthCheckTargetError, checkContainerHealth, healthCheckUrl, waitForHealthy } =
  await import('../../worker/src/services/healthCheckService.js');
const { default: workerConfig } = await import('../../worker/src/config/index.js');

const HOST = '127.0.0.1';
const servers = [];

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

// Starts an HTTP server on a free port; `handler(req, res)` answers, and every
// request is recorded in `server.requests`.
async function startApp(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, at: performance.now() });
    handler(req, res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  servers.push(server);
  return { port: server.address().port, requests };
}

const respondWith = (statusCode) => (req, res) => {
  res.writeHead(statusCode);
  res.end('body');
};

// A port nothing listens on.
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('checkContainerHealth', () => {
  test('HTTP 200 is healthy and reports the status code and response time', async () => {
    const app = await startApp(respondWith(200));
    const result = await checkContainerHealth({ host: HOST, port: app.port, path: '/health', timeout: 1000 });

    assert.equal(result.healthy, true);
    assert.equal(result.statusCode, 200);
    assert.ok(Number.isInteger(result.responseTime) && result.responseTime >= 0);
    assert.equal(result.error, undefined);
    assert.deepEqual(app.requests.map(({ method, url }) => ({ method, url })), [{ method: 'GET', url: '/health' }]);
  });

  test('any 2xx response is healthy', async () => {
    for (const statusCode of [201, 204]) {
      const app = await startApp(respondWith(statusCode));
      const result = await checkContainerHealth({ host: HOST, port: app.port, path: '/health', timeout: 1000 });
      assert.deepEqual({ healthy: result.healthy, statusCode: result.statusCode }, { healthy: true, statusCode });
    }
  });

  test('HTTP 4xx and 5xx are unhealthy: 400, 404, 500, 503', async () => {
    for (const statusCode of [400, 404, 500, 503]) {
      const app = await startApp(respondWith(statusCode));
      const result = await checkContainerHealth({ host: HOST, port: app.port, path: '/health', timeout: 1000 });
      assert.equal(result.healthy, false);
      assert.equal(result.statusCode, statusCode);
      assert.equal(result.error, `Health check returned HTTP ${statusCode}`);
    }
  });

  test('redirects are unhealthy and are never followed', async () => {
    const elsewhere = await startApp(respondWith(200));
    const app = await startApp((req, res) => {
      res.writeHead(302, { location: `http://${HOST}:${elsewhere.port}/health` });
      res.end();
    });
    const result = await checkContainerHealth({ host: HOST, port: app.port, path: '/health', timeout: 1000 });

    assert.equal(result.healthy, false);
    assert.equal(result.statusCode, 302);
    assert.equal(elsewhere.requests.length, 0);
  });

  test('a response slower than the timeout is unhealthy, and the check returns on time', async () => {
    const app = await startApp(() => {}); // accepts the request, never answers
    const started = performance.now();
    const result = await checkContainerHealth({ host: HOST, port: app.port, path: '/health', timeout: 200 });
    const elapsed = performance.now() - started;

    assert.deepEqual(
      { healthy: result.healthy, statusCode: result.statusCode, error: result.error },
      { healthy: false, statusCode: undefined, error: 'Health check timed out after 200ms' },
    );
    assert.ok(elapsed >= 190 && elapsed < 1500, `returned after ${elapsed.toFixed(0)}ms`);
  });

  test('connection refused is unhealthy', async () => {
    const port = await closedPort();
    const result = await checkContainerHealth({ host: HOST, port, path: '/health', timeout: 1000 });
    assert.equal(result.healthy, false);
    assert.equal(result.statusCode, undefined);
    assert.equal(result.error, `Connection refused on ${HOST}:${port}`);
  });

  test('a server that does not speak HTTP is unhealthy, not a crash', async () => {
    const server = net.createServer((socket) => socket.end('this is not http\r\n\r\n'));
    await new Promise((resolve) => server.listen(0, HOST, resolve));
    servers.push(server);
    const result = await checkContainerHealth({ host: HOST, port: server.address().port, path: '/health', timeout: 1000 });
    assert.equal(result.healthy, false);
    assert.match(result.error, /^(Health check request failed: |Connection closed before a response was received)/);
  });

  test('the path is configurable, including a query string', async () => {
    const app = await startApp((req, res) => respondWith(req.url === '/api/v1/status?probe=1' ? 200 : 404)(req, res));
    assert.equal((await checkContainerHealth({ host: HOST, port: app.port, path: '/api/v1/status?probe=1' })).healthy, true);
    assert.equal((await checkContainerHealth({ host: HOST, port: app.port, path: '/health' })).statusCode, 404);
    assert.equal((await checkContainerHealth({ host: HOST, port: app.port, path: '/' })).statusCode, 404);
  });

  test('host, timeout, interval, retries and grace period come from the worker configuration', async () => {
    assert.deepEqual(workerConfig.healthCheck, {
      host: '127.0.0.1',
      timeoutMs: 1500,
      intervalMs: 250,
      retries: 4,
      startupGraceMs: 0,
    });

    // ...and are what a health check uses when the caller passes none.
    const checks = [];
    const sleeps = [];
    const result = await waitForHealthy({
      port: 8080,
      path: '/health',
      check: async (target) => {
        checks.push(target);
        return { healthy: false, error: 'down' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.attempts, 4);
    assert.deepEqual(checks[0], { host: '127.0.0.1', port: 8080, path: '/health', timeout: 1500 });
    // No startup wait (grace period 0), then the interval between attempts.
    assert.deepEqual(sleeps, [250, 250, 250]);
  });
});

describe('health-check targets', () => {
  test('only allowed hosts, valid ports and plain absolute paths are accepted', () => {
    assert.equal(healthCheckUrl({ host: HOST, port: 8080, path: '/health' }).href, 'http://127.0.0.1:8080/health');
    assert.equal(healthCheckUrl({ host: 'localhost', port: 80, path: '/' }).href, 'http://localhost/');
    assert.equal(healthCheckUrl({ host: '::1', port: 3000, path: '/a/b/' }).href, 'http://[::1]:3000/a/b/');

    for (const host of ['example.com', '169.254.169.254', '10.0.0.5', 'postgres', '127.0.0.1@evil.example', '']) {
      assert.throws(() => healthCheckUrl({ host, port: 80, path: '/health' }), HealthCheckTargetError, `host "${host}"`);
    }
    for (const port of [0, -1, 65536, 80.5, '80', null, undefined, NaN]) {
      assert.throws(() => healthCheckUrl({ host: HOST, port, path: '/health' }), HealthCheckTargetError, `port ${port}`);
    }
    for (const path of [
      'health',
      '',
      '//evil.example/health',
      '/a//b',
      'http://evil.example/health',
      '/@evil.example',
      '/health check',
      '/health\r\nHost: evil.example',
      '/health#fragment',
      '/\\evil.example',
      '/;rm -rf /',
      `/${'a'.repeat(300)}`,
      null,
      undefined,
    ]) {
      assert.throws(() => healthCheckUrl({ host: HOST, port: 80, path }), HealthCheckTargetError, `path ${path}`);
    }
    assert.ok(HEALTH_CHECK_PATH_PATTERN.test('/healthz'));
  });

  test('an invalid target is reported as unhealthy without any request', async () => {
    const app = await startApp(respondWith(200));
    const badHost = await checkContainerHealth({ host: 'example.com', port: app.port, path: '/health' });
    assert.deepEqual(badHost, { healthy: false, error: 'Health check host "example.com" is not allowed' });

    const badPath = await checkContainerHealth({ host: HOST, port: app.port, path: '//evil.example/' });
    assert.deepEqual(badPath, { healthy: false, error: 'Health check path must be an absolute path such as /health' });

    const badPort = await checkContainerHealth({ host: HOST, port: null, path: '/health' });
    assert.deepEqual(badPort, { healthy: false, error: 'Health check port "null" is not a valid port' });
    assert.equal(app.requests.length, 0);
  });
});

describe('waitForHealthy (retries)', () => {
  // Collects log lines and replaces real waiting with a record of the waits.
  function recorder() {
    const logs = [];
    const sleeps = [];
    return {
      logs,
      sleeps,
      onLog: (level, message) => logs.push(`${level} ${message}`),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
  }
  const settings = { host: HOST, path: '/health', timeout: 500, interval: 40, startupGracePeriod: 0 };

  test('a failed attempt is retried: fail, fail, then healthy', async () => {
    const app = await startApp((req, res, count) => respondWith(count < 3 ? 503 : 200)(req, res));
    const { logs, sleeps, onLog, sleep } = recorder();
    const result = await waitForHealthy({ ...settings, port: app.port, retries: 5, onLog, sleep });

    assert.equal(result.healthy, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.statusCode, 200);
    assert.equal(app.requests.length, 3);
    assert.deepEqual(sleeps, [40, 40]);
    assert.deepEqual(logs.slice(0, 2), [
      'WARN Health check attempt 1/5 failed: Health check returned HTTP 503',
      'WARN Health check attempt 2/5 failed: Health check returned HTTP 503',
    ]);
    assert.match(logs[2], /^INFO Health check attempt 3\/5 passed: HTTP 200 in \d+ms$/);
  });

  test('every attempt is handed to onAttempt, before its log line', async () => {
    const app = await startApp((req, res, count) => respondWith(count < 2 ? 503 : 200)(req, res));
    const { logs, onLog, sleep } = recorder();
    const seen = [];
    await waitForHealthy({
      ...settings,
      port: app.port,
      retries: 3,
      onLog,
      sleep,
      onAttempt: ({ attempt, maxAttempts, result }) => {
        seen.push(`${attempt}/${maxAttempts} HTTP ${result.statusCode} healthy=${result.healthy} logged=${logs.length}`);
      },
    });
    assert.deepEqual(seen, ['1/3 HTTP 503 healthy=false logged=0', '2/3 HTTP 200 healthy=true logged=1']);
  });

  test('when every attempt fails it stops after the configured number and reports the last error', async () => {
    const app = await startApp(respondWith(500));
    const { logs, sleeps, onLog, sleep } = recorder();
    const result = await waitForHealthy({ ...settings, port: app.port, retries: 4, onLog, sleep });

    assert.deepEqual(
      { healthy: result.healthy, attempts: result.attempts, statusCode: result.statusCode, error: result.error },
      { healthy: false, attempts: 4, statusCode: 500, error: 'Health check returned HTTP 500' },
    );
    assert.equal(app.requests.length, 4);
    // Waits between attempts only, not after the last one.
    assert.deepEqual(sleeps, [40, 40, 40]);
    assert.equal(logs.length, 4);
    assert.equal(logs.at(-1), 'WARN Health check attempt 4/4 failed: Health check returned HTTP 500');
  });

  test('the interval between attempts is respected', async () => {
    const app = await startApp((req, res, count) => respondWith(count < 3 ? 500 : 200)(req, res));
    await waitForHealthy({ ...settings, interval: 120, port: app.port, retries: 3 });
    const [first, second, third] = app.requests.map((request) => request.at);
    assert.ok(second - first >= 110, `second attempt after ${(second - first).toFixed(0)}ms`);
    assert.ok(third - second >= 110, `third attempt after ${(third - second).toFixed(0)}ms`);
  });

  test('the startup grace period passes before the first attempt', async () => {
    const app = await startApp(respondWith(200));
    const logs = [];
    const started = performance.now();
    const result = await waitForHealthy({
      ...settings,
      port: app.port,
      retries: 2,
      startupGracePeriod: 250,
      onLog: (level, message) => logs.push(`${level} ${message}`),
    });

    assert.equal(result.healthy, true);
    assert.equal(result.attempts, 1);
    assert.ok(app.requests[0].at - started >= 240, `first attempt after ${(app.requests[0].at - started).toFixed(0)}ms`);
    assert.equal(logs[0], 'INFO Waiting 0.25s for the application to start');
  });

  test('an application that only becomes ready after the grace period passes on the first attempt', async () => {
    const readyAt = performance.now() + 150;
    const app = await startApp((req, res) => respondWith(performance.now() >= readyAt ? 200 : 503)(req, res));
    const result = await waitForHealthy({ ...settings, port: app.port, retries: 1, startupGracePeriod: 200 });
    assert.deepEqual({ healthy: result.healthy, attempts: result.attempts }, { healthy: true, attempts: 1 });
  });

  test('timeouts and refused connections are retried like any other failure', async () => {
    const port = await closedPort();
    const refused = await waitForHealthy({ ...settings, port, retries: 2, ...recorder() });
    assert.deepEqual(
      { healthy: refused.healthy, attempts: refused.attempts, error: refused.error },
      { healthy: false, attempts: 2, error: `Connection refused on ${HOST}:${port}` },
    );

    const slow = await startApp(() => {});
    const timedOut = await waitForHealthy({ ...settings, timeout: 100, port: slow.port, retries: 2, ...recorder() });
    assert.equal(timedOut.error, 'Health check timed out after 100ms');
    assert.equal(slow.requests.length, 2);
  });

  test('the number of attempts is always bounded', async () => {
    let calls = 0;
    const check = async () => {
      calls += 1;
      return { healthy: false, error: 'down' };
    };
    for (const [retries, expected] of [[0, 1], [-3, 1], [NaN, 1], [2.9, 2], [Infinity, 50], [1e9, 50]]) {
      calls = 0;
      const result = await waitForHealthy({ ...settings, port: 1, retries, check, ...recorder() });
      assert.equal(calls, expected, `retries=${retries}`);
      assert.equal(result.attempts, expected);
      assert.equal(result.healthy, false);
    }
  });

  test('a check that throws counts as a failed attempt instead of crashing', async () => {
    let calls = 0;
    const check = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { healthy: true, statusCode: 200, responseTime: 1 };
    };
    const { logs, onLog, sleep } = recorder();
    const result = await waitForHealthy({ ...settings, port: 1, retries: 3, check, onLog, sleep });
    assert.deepEqual({ healthy: result.healthy, attempts: result.attempts }, { healthy: true, attempts: 2 });
    assert.equal(logs[0], 'WARN Health check attempt 1/3 failed: Health check request failed: boom');
  });
});
