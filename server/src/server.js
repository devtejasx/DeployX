import app from './app.js';
import config, { productionConfigProblems } from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { connectRedis, closeRedis } from './db/redis.js';
import { closeAllLogStreams } from './controllers/logStream.controller.js';
import { closeSubscriber } from './events/deploymentSubscriber.js';
import { beginShutdown } from './lib/lifecycle.js';
import { logger } from './lib/logger.js';
import { closeDeploymentQueue } from './queues/deploymentQueue.js';

// Development defaults (passwords, insecure cookies, "*" origins) must never
// reach production: refuse to start instead.
if (config.env === 'production') {
  const problems = productionConfigProblems();
  if (problems.length > 0) {
    logger.error('unsafe_configuration', { msg: 'refusing to start: unsafe production configuration', problems });
    process.exit(1);
  }
}

connectRedis();

const server = app.listen(config.port, () => {
  logger.info('api_started', { port: config.port, env: config.env });
});

// Graceful shutdown:
//   1. readiness turns 503 (load balancers stop sending new requests)
//   2. the server stops accepting connections; idle keep-alive ones close
//   3. live log streams end (browsers reconnect to another instance)
//   4. running requests finish, then the queue, Redis and PostgreSQL close
// If that takes longer than API_SHUTDOWN_TIMEOUT_MS, the process exits
// anyway. The API holds no deployment state of its own: PostgreSQL and the
// queue do, so nothing is left half-written.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  beginShutdown();
  logger.info('api_stopping', { signal });

  const forceExit = setTimeout(() => {
    logger.error('api_shutdown_timeout', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  closeAllLogStreams();
  await closed;
  await closeSubscriber().catch(() => {});
  // The queue uses the shared Redis connection, so close it first.
  await closeDeploymentQueue().catch(() => {});
  await Promise.allSettled([closePostgres(), closeRedis()]);
  logger.info('api_stopped');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { err: reason });
});
// After an uncaught exception the process state is unknown: log it and exit
// (Docker / ECS restart the API).
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { err });
  process.exit(1);
});
