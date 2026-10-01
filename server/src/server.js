import app from './app.js';
import config, { productionConfigProblems } from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { connectRedis, closeRedis } from './db/redis.js';
import { closeAllLogStreams } from './controllers/logStream.controller.js';
import { closeSubscriber } from './events/deploymentSubscriber.js';
import { closeDeploymentQueue } from './queues/deploymentQueue.js';

// Development defaults (passwords, insecure cookies, "*" origins) must never
// reach production: refuse to start instead.
if (config.env === 'production') {
  const problems = productionConfigProblems();
  if (problems.length > 0) {
    console.error(`[api] refusing to start: unsafe production configuration:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
}

connectRedis();

const server = app.listen(config.port, () => {
  console.log(`[api] DeployX API listening on port ${config.port} (${config.env})`);
});

async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  // End live log streams (browsers reconnect elsewhere), then their subscriber.
  closeAllLogStreams();
  await closeSubscriber().catch(() => {});
  // The queue uses the shared Redis connection, so close it first.
  await closeDeploymentQueue().catch(() => {});
  await Promise.allSettled([closePostgres(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
