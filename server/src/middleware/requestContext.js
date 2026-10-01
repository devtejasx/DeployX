import crypto from 'node:crypto';
import { logger } from '../lib/logger.js';
import { httpRequestDuration, httpRequestErrors } from '../lib/metrics.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
// Probes are logged at debug level only: they arrive every few seconds.
const QUIET_PATHS = new Set(['/health', '/ready', '/metrics', '/api/health', '/api/ready']);

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

// The route pattern ("/api/projects/:id"), never the concrete URL, so
// metrics have a bounded number of label values. Routers mounted on a path
// with parameters (/api/projects/:projectId/deployments) report it concrete
// in req.baseUrl; its IDs are replaced.
function routeOf(req) {
  if (!req.route?.path) return 'unmatched';
  const base = req.baseUrl.replace(UUID_SEGMENT, '/:id');
  return `${base}${req.route.path === '/' ? '' : req.route.path}` || '/';
}

// Gives every request an ID (X-Request-Id: the caller's, when it looks like
// one, or a new UUID), returned in the response header and attached to its
// log lines and audit entries. When the response is sent, the request is
// logged and measured: method, route, status and duration - never headers,
// cookies or bodies.
export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const route = routeOf(req);
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDuration.observe(labels, seconds);
    if (res.statusCode >= 500) httpRequestErrors.inc(labels);

    const path = req.originalUrl.split('?')[0].slice(0, 300);
    const level = res.statusCode >= 500 ? 'error' : QUIET_PATHS.has(path) ? 'debug' : 'info';
    logger[level]('http_request', {
      requestId: req.id,
      method: req.method,
      path,
      route,
      status: res.statusCode,
      durationMs: Math.round(seconds * 1000),
      userId: req.user?.id,
      ip: req.ip,
    });
  });
  next();
}
