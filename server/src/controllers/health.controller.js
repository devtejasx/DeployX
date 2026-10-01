import crypto from 'node:crypto';
import config from '../config/index.js';
import { isShuttingDown } from '../lib/lifecycle.js';
import { registry } from '../lib/metrics.js';
import { getSystemStatus } from '../services/systemStatus.service.js';
import { sendSuccess } from '../utils/response.js';

// Liveness: the process runs and answers. Never touches PostgreSQL or Redis,
// so a database outage does not get the API restarted (which would not help).
export function getHealth(req, res) {
  sendSuccess(res, {
    status: 'ok',
    service: 'deployx-api',
    timestamp: new Date().toISOString(),
  });
}

// Readiness: the API can serve requests - PostgreSQL and Redis answer and no
// shutdown is in progress. 503 otherwise, so a load balancer stops routing
// to this instance. Says which check failed, not why (no connection details).
export async function getReadiness(req, res) {
  const { status } = await getSystemStatus();
  const checks = {
    postgres: status.database === 'connected' ? 'ok' : 'unavailable',
    redis: status.redis === 'connected' ? 'ok' : 'unavailable',
    shutdown: isShuttingDown() ? 'in_progress' : 'no',
  };
  const ready = checks.postgres === 'ok' && checks.redis === 'ok' && !isShuttingDown();
  res.status(ready ? 200 : 503).json({
    success: ready,
    data: { status: ready ? 'ready' : 'not_ready', checks, timestamp: new Date().toISOString() },
    ...(ready ? {} : { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service is not ready' } }),
  });
}

function bearerMatches(header, token) {
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

// GET /metrics (Prometheus text format). With METRICS_TOKEN set, scrapers
// must send "Authorization: Bearer <token>". Without it the endpoint is open
// in development and disabled in production.
export async function getMetrics(req, res) {
  const { token } = config.metrics;
  if (token) {
    if (!bearerMatches(req.get('authorization'), token)) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Metrics token required' } });
      return;
    }
  } else if (config.env === 'production') {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Metrics are disabled (set METRICS_TOKEN)' } });
    return;
  }
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
