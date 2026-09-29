import config from '../config/index.js';

// Publishes real-time deployment events to Redis Pub/Sub, in the same format
// and on the same per-deployment channels as the API
// (server/src/events/deploymentEvents.js):
//   channel  <QUEUE_PREFIX>:deployment:<deployment-id>:events
//   message  { type: 'log', deploymentId, log } | { type: 'status', deploymentId, status }
//
// The worker's existing Redis connection is reused (set by worker.js); no
// extra connection is opened. Publishing is best effort: logs and statuses
// are already persisted in PostgreSQL before they are published.
let publisher = null;
let lastWarning = 0;

export function setEventPublisher(connection) {
  publisher = connection;
}

export function clearEventPublisher(connection) {
  if (publisher === connection) publisher = null;
}

export function deploymentChannel(deploymentId) {
  return `${config.queue.prefix}:deployment:${deploymentId}:events`;
}

async function publish(deploymentId, event) {
  if (!publisher) return;
  try {
    await publisher.publish(deploymentChannel(deploymentId), JSON.stringify({ ...event, deploymentId }));
  } catch (err) {
    if (Date.now() - lastWarning > 60000) {
      lastWarning = Date.now();
      console.warn('[worker] could not publish deployment event:', err.message || err);
    }
  }
}

export function publishLog(deploymentId, log) {
  if (!log) return undefined;
  const { id, level, message, created_at: createdAt } = log;
  return publish(deploymentId, { type: 'log', log: { id: String(id), level, message, created_at: createdAt } });
}

export function publishStatus(deploymentId, status) {
  return publish(deploymentId, { type: 'status', status });
}
