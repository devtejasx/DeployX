import http from 'node:http';
import config from '../config/index.js';

// Upper bound on attempts, whatever the configuration says.
const MAX_ATTEMPTS = 50;
const MAX_PATH_LENGTH = 255;

// "/", "/health", "/api/v1/health/", "/health?probe=1". Same rule as the API
// (server/src/validators/project.validators.js) and the database CHECK: the
// path is the only part of a health check that comes from a user, and it can
// never contain a scheme, a host, credentials or whitespace.
export const HEALTH_CHECK_PATH_PATTERN =
  /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?(?:\?[A-Za-z0-9._~=&-]*)?$/;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HealthCheckTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HealthCheckTargetError';
  }
}

// Hosts a health check may be sent to: this machine, and the host the
// operator configured (HEALTH_CHECK_HOST). Nothing a user controls.
function allowedHosts() {
  return new Set(['127.0.0.1', 'localhost', '::1', config.healthCheck.host]);
}

// The URL of a health check, or HealthCheckTargetError for anything that is
// not a plain HTTP request to an allowed host and a valid port and path.
export function healthCheckUrl({ host = config.healthCheck.host, port, path }) {
  if (!allowedHosts().has(host)) {
    throw new HealthCheckTargetError(`Health check host "${host}" is not allowed`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HealthCheckTargetError(`Health check port "${port}" is not a valid port`);
  }
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !HEALTH_CHECK_PATH_PATTERN.test(path)) {
    throw new HealthCheckTargetError('Health check path must be an absolute path such as /health');
  }

  const authority = host.includes(':') ? `[${host}]` : host;
  const url = new URL(`http://${authority}:${port}${path}`);
  // Defence in depth: the path must not have changed where the request goes.
  const sameTarget =
    url.protocol === 'http:' &&
    url.hostname === authority.toLowerCase() &&
    Number(url.port || 80) === port &&
    !url.username &&
    !url.password;
  if (!sameTarget) {
    throw new HealthCheckTargetError('Health check path must be an absolute path such as /health');
  }
  return url;
}

// One GET without following redirects. Resolves with the status code as soon
// as the response headers arrive (the body is not downloaded).
function requestStatus(url, timeout) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: 'GET', agent: false, headers: { 'user-agent': 'DeployX-HealthCheck', accept: '*/*' } },
      (response) => {
        clearTimeout(timer);
        response.destroy();
        resolve(response.statusCode);
      },
    );
    // Covers the whole request: connecting, sending and waiting for headers.
    const timer = setTimeout(() => {
      request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    }, timeout);
    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

function describeFailure(err, { url, timeout }) {
  switch (err.code) {
    case 'ETIMEDOUT':
      return `Health check timed out after ${timeout}ms`;
    case 'ECONNREFUSED':
      return `Connection refused on ${url.host}`;
    case 'ECONNRESET':
    case 'EPIPE':
      return 'Connection closed before a response was received';
    default:
      return `Health check request failed: ${err.code || err.message || 'unknown error'}`;
  }
}

// One health check of a deployed application: GET http://<host>:<port><path>.
// Healthy means a 2xx response within `timeout` ms; redirects are not
// followed. Never throws:
//   { healthy: true,  statusCode: 200, responseTime: 143 }
//   { healthy: false, statusCode: 500, responseTime: 12, error: 'Health check returned HTTP 500' }
//   { healthy: false, responseTime: 2001, error: 'Health check timed out after 2000ms' }
export async function checkContainerHealth({
  host = config.healthCheck.host,
  port,
  path,
  timeout = config.healthCheck.timeoutMs,
}) {
  let url;
  try {
    url = healthCheckUrl({ host, port, path });
  } catch (err) {
    return { healthy: false, error: err.message };
  }

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const statusCode = await requestStatus(url, timeout);
    if (statusCode >= 200 && statusCode < 300) {
      return { healthy: true, statusCode, responseTime: elapsed() };
    }
    return { healthy: false, statusCode, responseTime: elapsed(), error: `Health check returned HTTP ${statusCode}` };
  } catch (err) {
    return { healthy: false, responseTime: elapsed(), error: describeFailure(err, { url, timeout }) };
  }
}

// Checks the application until it is healthy or the attempts are used up:
//   wait startupGracePeriod -> attempt 1 -> (fail) wait interval -> attempt 2 -> ...
// A single failed request is never final, and the loop is bounded by
// `retries` (at most MAX_ATTEMPTS). Each step is reported through
// `onLog(level, message)`. Returns the last check result plus `attempts`:
//   { healthy: true,  attempts: 3, statusCode: 200, responseTime: 143 }
//   { healthy: false, attempts: 5, statusCode: 500, error: 'Health check returned HTTP 500' }
export async function waitForHealthy({
  host = config.healthCheck.host,
  port,
  path,
  timeout = config.healthCheck.timeoutMs,
  interval = config.healthCheck.intervalMs,
  retries = config.healthCheck.retries,
  startupGracePeriod = config.healthCheck.startupGraceMs,
  onLog = () => {},
  check = checkContainerHealth,
  sleep = defaultSleep,
}) {
  const maxAttempts = Math.min(Math.max(Math.trunc(retries) || 1, 1), MAX_ATTEMPTS);

  if (startupGracePeriod > 0) {
    await onLog('INFO', `Waiting ${startupGracePeriod / 1000}s for the application to start`);
    await sleep(startupGracePeriod);
  }

  let result = { healthy: false, error: 'Health check did not run' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await check({ host, port, path, timeout });
    } catch (err) {
      result = { healthy: false, error: `Health check request failed: ${err.message}` };
    }

    if (result.healthy) {
      await onLog(
        'INFO',
        `Health check attempt ${attempt}/${maxAttempts} passed: HTTP ${result.statusCode} in ${result.responseTime}ms`,
      );
      return { ...result, attempts: attempt };
    }

    await onLog('WARN', `Health check attempt ${attempt}/${maxAttempts} failed: ${result.error}`);
    if (attempt < maxAttempts) await sleep(interval);
  }
  return { ...result, attempts: maxAttempts };
}
