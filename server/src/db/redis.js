import IORedis from 'ioredis';
import config from '../config/index.js';
import { logger } from '../lib/logger.js';

// The API's single Redis connection. It serves the system status check and
// the BullMQ deployment queue (see queues/deploymentQueue.js), so the API
// never opens more than one connection to Redis.
const redisConnection = new IORedis(config.redisUrl, {
  // Connect explicitly from server.js (connectRedis) rather than on import.
  lazyConnect: true,
  // Fail commands immediately while disconnected instead of queueing them,
  // so status checks and job submission report the outage rather than hang.
  enableOfflineQueue: false,
  connectTimeout: 3000,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
});

let lastErrorMessage = null;

// Without an error listener ioredis would log unhandled errors on every retry.
redisConnection.on('error', (err) => {
  const message = err.message || err.code || String(err);
  if (message !== lastErrorMessage) {
    logger.error('redis_connection_error', { msg: message });
    lastErrorMessage = message;
  }
});

redisConnection.on('ready', () => {
  lastErrorMessage = null;
  logger.info('redis_connected');
});

// Start connecting in the background. The client keeps retrying on its own,
// so the API can start even while Redis is down.
export function connectRedis() {
  if (redisConnection.status !== 'wait') return;
  redisConnection.connect().catch((err) => {
    logger.error('redis_initial_connection_failed', { err });
  });
}

export async function pingRedis() {
  if (redisConnection.status !== 'ready') {
    throw new Error('Redis client is not connected');
  }
  await redisConnection.ping();
}

export async function closeRedis() {
  if (redisConnection.status === 'ready') {
    await redisConnection.quit();
  } else {
    redisConnection.disconnect();
  }
}

export default redisConnection;
