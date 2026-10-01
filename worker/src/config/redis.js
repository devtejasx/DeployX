import IORedis from 'ioredis';
import config from './index.js';
import { logger } from '../lib/logger.js';

// The worker's Redis connection, from REDIS_URL. BullMQ uses it for queue
// commands and duplicates it once for the blocking "wait for next job" call,
// so a worker process holds two connections in total.
export function createRedisConnection() {
  const connection = new IORedis(config.redisUrl, {
    // Required by BullMQ workers: blocking commands must never be retried.
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  let lastErrorMessage = null;
  connection.on('error', (err) => {
    const message = err.message || err.code || String(err);
    if (message !== lastErrorMessage) {
      logger.error('redis_connection_error', { msg: message });
      lastErrorMessage = message;
    }
  });
  connection.on('ready', () => {
    lastErrorMessage = null;
  });

  return connection;
}
