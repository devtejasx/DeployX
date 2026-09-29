import config from '../config/index.js';
import redisConnection from '../db/redis.js';

// Real-time deployment events over Redis Pub/Sub.
//
// Every persisted log line and every status change is published on the
// deployment's own channel, so events of one deployment never reach another's
// subscribers. Messages (JSON):
//   { type: 'log',    deploymentId, log: { id, level, message, created_at } }
//   { type: 'status', deploymentId, status }
// The worker publishes the same messages on the same channels
// (worker/src/events/deploymentEvents.js); both must agree on this format.
//
// Events are notifications only: PostgreSQL stays the source of truth, and
// publishing is best effort - a Redis outage never fails the operation that
// produced the event (live streams fall back to polling the database).
export function deploymentChannel(deploymentId) {
  return `${config.queue.prefix}:deployment:${deploymentId}:events`;
}

let lastWarning = 0;

async function publish(deploymentId, event) {
  try {
    await redisConnection.publish(deploymentChannel(deploymentId), JSON.stringify({ ...event, deploymentId }));
  } catch (err) {
    // At most one warning a minute while Redis is down.
    if (Date.now() - lastWarning > 60000) {
      lastWarning = Date.now();
      console.warn('[events] could not publish deployment event:', err.message || err);
    }
  }
}

export function publishLog(deploymentId, log) {
  const { id, level, message, created_at: createdAt } = log;
  return publish(deploymentId, { type: 'log', log: { id: String(id), level, message, created_at: createdAt } });
}

export function publishStatus(deploymentId, status) {
  return publish(deploymentId, { type: 'status', status });
}
