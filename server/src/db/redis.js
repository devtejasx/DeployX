import { createClient } from 'redis';
import config from '../config/index.js';

const redisClient = createClient({
  url: config.redisUrl,
  // Fail commands immediately while disconnected instead of queueing them,
  // so status checks report the outage rather than hanging.
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 3000,
    reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
  },
});

let lastErrorMessage = null;

// Without an error listener node-redis would crash the process on connection loss.
redisClient.on('error', (err) => {
  const message = err.message || err.code || String(err);
  if (message !== lastErrorMessage) {
    console.error('[redis] connection error:', message);
    lastErrorMessage = message;
  }
});

redisClient.on('ready', () => {
  lastErrorMessage = null;
  console.log('[redis] connected');
});

// Start connecting in the background. The client keeps retrying on its own,
// so the API can start even while Redis is down.
export function connectRedis() {
  redisClient.connect().catch((err) => {
    console.error('[redis] initial connection failed:', err.message);
  });
}

export async function pingRedis() {
  if (!redisClient.isReady) {
    throw new Error('Redis client is not connected');
  }
  await redisClient.ping();
}

export async function closeRedis() {
  if (redisClient.isOpen) {
    await redisClient.quit();
  }
}

export default redisClient;
