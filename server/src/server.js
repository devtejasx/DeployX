import app from './app.js';
import config, { productionConfigProblems } from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { connectRedis, closeRedis } from './db/redis.js';
import { closeAllLogStreams } from './controllers/logStream.controller.js';
import { closeSubscriber } from './events/deploymentSubscriber.js';
import { logger } from './lib/logger.js';
import { createShutdown } from './lib/shutdown.js';
import { closeDeploymentQueue } from './queues/deploymentQueue.js';
import { startSessionCleanup } from './services/session.service.js';

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

// Expired and idle sessions are removed every SESSION_CLEANUP_INTERVAL_MS.
const sessionCleanup = startSessionCleanup();

// See lib/shutdown.js for the order of the steps.
const shutdown = createShutdown({
  server,
  timeoutMs: config.shutdownTimeoutMs,
  stopTimers: () => sessionCleanup.stop(),
  closeStreams: closeAllLogStreams,
  closeSubscriber,
  closeQueue: closeDeploymentQueue,
  closeConnections: () => Promise.allSettled([closePostgres(), closeRedis()]),
});

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
