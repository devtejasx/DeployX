import app from './app.js';
import config from './config/index.js';
import { closePostgres } from './db/postgres.js';
import { connectRedis, closeRedis } from './db/redis.js';

connectRedis();

const server = app.listen(config.port, () => {
  console.log(`[api] DeployX API listening on port ${config.port} (${config.env})`);
});

async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await Promise.allSettled([closePostgres(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
