import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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

// ---------------------------------------------------------------------------
// Service URLs (AWS_ECS): https://my-app.example.com + /health
//
// Unlike a local container, the host comes from the project (its
// aws_service_url), so the worker must not become a way to reach internal
// systems. The host is resolved once, every address it resolves to must be
// allowed, and the request is sent to exactly that address (a DNS answer
// changing in between cannot redirect it):
// - never: link-local (169.254.0.0/16, fe80::/10, which include the cloud
//   instance metadata service), unspecified, multicast and reserved addresses
// - only with HEALTH_CHECK_ALLOW_PRIVATE_URLS=true: private, loopback and
//   shared addresses (an internal load balancer, the worker in the same VPC)
// ---------------------------------------------------------------------------
const NEVER_ALLOWED = new net.BlockList();
NEVER_ALLOWED.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER_ALLOWED.addSubnet('169.254.0.0', 16, 'ipv4');
NEVER_ALLOWED.addSubnet('224.0.0.0', 4, 'ipv4');
NEVER_ALLOWED.addSubnet('240.0.0.0', 4, 'ipv4');
NEVER_ALLOWED.addAddress('::', 'ipv6');
NEVER_ALLOWED.addSubnet('fe80::', 10, 'ipv6');
NEVER_ALLOWED.addSubnet('ff00::', 8, 'ipv6');
NEVER_ALLOWED.addAddress('fd00:ec2::254', 'ipv6');

const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

// 'public', 'private' or 'forbidden' (also for anything that is not an IP).
export function classifyAddress(address) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address ?? '');
  const ip = mapped ? mapped[1] : address;
  const version = net.isIP(ip ?? '');
  if (version === 0) return 'forbidden';
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (NEVER_ALLOWED.check(ip, family)) return 'forbidden';
  return PRIVATE.check(ip, family) ? 'private' : 'public';
}

// The URL of a health check on a service: `baseUrl` must be an http(s) origin
// (as the API stores aws_service_url) and `path` the project's health path.
export function serviceHealthCheckUrl({ baseUrl, path }) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new HealthCheckTargetError('Service URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.origin !== baseUrl) {
    throw new HealthCheckTargetError('Service URL must be an http(s) origin such as https://my-app.example.com');
  }
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !HEALTH_CHECK_PATH_PATTERN.test(path)) {
    throw new HealthCheckTargetError('Health check path must be an absolute path such as /health');
  }
  const url = new URL(`${base.origin}${path}`);
  if (url.origin !== base.origin) {
    throw new HealthCheckTargetError('Health check path must be an absolute path such as /health');
  }
  return url;
}

// The address to send the request to: { address, family }. Throws
// HealthCheckTargetError if the host resolves to an address that is not allowed.
async function resolveTarget(hostname, { allowPrivate, lookup }) {
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const addresses = net.isIP(literal)
    ? [{ address: literal, family: net.isIP(literal) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new HealthCheckTargetError(`${hostname} did not resolve to an address`);

  for (const { address } of addresses) {
    const kind = classifyAddress(address);
    if (kind === 'forbidden') {
      throw new HealthCheckTargetError(`${hostname} resolves to ${address}, which health checks may not reach`);
    }
    if (kind === 'private' && !allowPrivate) {
      throw new HealthCheckTargetError(
        `${hostname} resolves to the private address ${address} ` +
          '(set HEALTH_CHECK_ALLOW_PRIVATE_URLS=true if the service is only reachable privately)',
      );
    }
  }
  return addresses[0];
}

function withTimeout(promise, ms, error) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One GET without following redirects. Resolves with the status code as soon
// as the response headers arrive (the body is not downloaded). With
// `address`, the connection goes to that address whatever DNS says by then
// (HTTPS still verifies the certificate against the URL's host name).
function requestStatus(url, timeout, { transport = http, address } = {}) {
  const options = { method: 'GET', agent: false, headers: { 'user-agent': 'DeployX-HealthCheck', accept: '*/*' } };
  if (address) {
    options.lookup = (hostname, lookupOptions, callback) =>
      lookupOptions?.all ? callback(null, [address]) : callback(null, address.address, address.family);
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      options,
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

// One health check of a service (AWS_ECS): GET <baseUrl><path>, http or
// https, only to allowed addresses (see above). Same results as
// checkContainerHealth; never throws.
export async function checkServiceHealth({
  baseUrl,
  path,
  timeout = config.healthCheck.timeoutMs,
  allowPrivate = config.healthCheck.allowPrivateUrls,
  lookup = dns.promises.lookup,
}) {
  let url;
  try {
    url = serviceHealthCheckUrl({ baseUrl, path });
  } catch (err) {
    return { healthy: false, error: err.message };
  }

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let address;
  try {
    address = await withTimeout(
      resolveTarget(url.hostname, { allowPrivate, lookup }),
      timeout,
      Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    );
  } catch (err) {
    const error =
      err instanceof HealthCheckTargetError
        ? err.message
        : err.code === 'ETIMEDOUT'
          ? `Health check timed out after ${timeout}ms`
          : `Could not resolve ${url.hostname}: ${err.code || err.message}`;
    return { healthy: false, responseTime: elapsed(), error };
  }

  try {
    const remaining = Math.max(timeout - elapsed(), 1);
    const statusCode = await requestStatus(url, remaining, {
      transport: url.protocol === 'https:' ? https : http,
      address,
    });
    if (statusCode >= 200 && statusCode < 300) {
      return { healthy: true, statusCode, responseTime: elapsed() };
    }
    return { healthy: false, statusCode, responseTime: elapsed(), error: `Health check returned HTTP ${statusCode}` };
  } catch (err) {
    return { healthy: false, responseTime: elapsed(), error: describeFailure(err, { url, timeout }) };
  }
}

// How many attempts a health check gets: `retries`, but at least 1 and never
// more than MAX_ATTEMPTS.
export function maxHealthCheckAttempts(retries = config.healthCheck.retries) {
  return Math.min(Math.max(Math.trunc(retries) || 1, 1), MAX_ATTEMPTS);
}

// Checks the application until it is healthy or the attempts are used up:
//   wait startupGracePeriod -> attempt 1 -> (fail) wait interval -> attempt 2 -> ...
// A single failed request is never final, and the loop is bounded by
// `retries` (at most MAX_ATTEMPTS). Each attempt is handed to
// `onAttempt({ attempt, maxAttempts, result })`, and each step is reported
// through `onLog(level, message)`. Returns the last check result plus `attempts`:
//   { healthy: true,  attempts: 3, statusCode: 200, responseTime: 143 }
//   { healthy: false, attempts: 5, statusCode: 500, error: 'Health check returned HTTP 500' }
// The target is a local container's published `port`, or a service's
// `baseUrl` (AWS_ECS); the retry rules are the same for both.
export async function waitForHealthy({
  host = config.healthCheck.host,
  port,
  baseUrl,
  path,
  timeout = config.healthCheck.timeoutMs,
  interval = config.healthCheck.intervalMs,
  retries = config.healthCheck.retries,
  startupGracePeriod = config.healthCheck.startupGraceMs,
  onAttempt = () => {},
  onLog = () => {},
  check = baseUrl ? checkServiceHealth : checkContainerHealth,
  sleep = defaultSleep,
}) {
  const maxAttempts = maxHealthCheckAttempts(retries);

  if (startupGracePeriod > 0) {
    await onLog('INFO', `Waiting ${startupGracePeriod / 1000}s for the application to start`);
    await sleep(startupGracePeriod);
  }

  let result = { healthy: false, error: 'Health check did not run' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await check(baseUrl ? { baseUrl, path, timeout } : { host, port, path, timeout });
    } catch (err) {
      result = { healthy: false, error: `Health check request failed: ${err.message}` };
    }
    await onAttempt({ attempt, maxAttempts, result });

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
