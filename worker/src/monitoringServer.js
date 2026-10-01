import crypto from 'node:crypto';
import http from 'node:http';
import config from './config/index.js';
import { query } from './db/postgres.js';
import { logger } from './lib/logger.js';
import { registry } from './lib/metrics.js';

// The worker's own HTTP endpoint (WORKER_METRICS_PORT; 0 turns it off), for
// orchestrators and Prometheus. It is not published by Docker Compose and
// serves nothing but:
//   GET /health   liveness: the process runs (200)
//   GET /ready    readiness: Redis and PostgreSQL answer and the worker is
//                 consuming jobs (200), otherwise 503
//   GET /metrics  Prometheus text; with METRICS_TOKEN set, scrapers must send
//                 "Authorization: Bearer <token>"

function tokenMatches(header, token) {
  const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(presented).digest(),
    crypto.createHash('sha256').update(token).digest(),
  );
}

function withTimeout(promise, ms = 2000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function startMonitoringServer({
  worker,
  connection,
  isStopping = () => false,
  port = config.monitoring.port,
  host = config.monitoring.host,
  token = config.monitoring.token,
}) {
  if (port === null || port === undefined) return null;

  async function readiness() {
    const checks = { redis: 'unavailable', postgres: 'unavailable', worker: 'stopped' };
    try {
      await withTimeout(connection.ping());
      checks.redis = 'ok';
    } catch {
      // stays unavailable
    }
    try {
      await withTimeout(query('SELECT 1'));
      checks.postgres = 'ok';
    } catch {
      // stays unavailable
    }
    checks.worker = isStopping() ? 'stopping' : worker.isRunning() ? 'running' : 'stopped';
    return { ready: checks.redis === 'ok' && checks.postgres === 'ok' && checks.worker === 'running', checks };
  }

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      if (path === '/health') return json(res, 200, { status: 'ok', service: 'deployx-worker' });
      if (path === '/ready') {
        const { ready, checks } = await readiness();
        return json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks });
      }
      if (path === '/metrics') {
        if (token && !tokenMatches(req.headers.authorization, token)) return json(res, 401, { error: 'Metrics token required' });
        res.writeHead(200, { 'content-type': registry.contentType });
        return res.end(await registry.metrics());
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error('monitoring_request_failed', { path, err });
      return json(res, 500, { error: 'Internal error' });
    }
  });

  server.on('error', (err) => logger.error('monitoring_server_error', { port, err }));
  server.listen(port, host, () => {
    logger.info('monitoring_server_started', { host, port: server.address().port });
  });

  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
