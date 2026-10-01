import crypto from 'node:crypto';
import os from 'node:os';
import config from '../config/index.js';
import { logger } from '../lib/logger.js';
import { lastHeartbeat } from '../lib/metrics.js';

// Worker heartbeats in Redis: every HEARTBEAT_INTERVAL_MS each worker writes
//   <QUEUE_PREFIX>:workers:<worker id>  =  { id, hostname, pid, status,
//      startedAt, lastHeartbeat, activeJobs, concurrency, queue }
// with a TTL of three intervals. A worker that stops writing (killed, hung,
// cut off from Redis) disappears by itself; the API reads these keys for the
// dashboard and for its "worker unavailable" alert. Nothing in them is
// secret. A graceful shutdown marks the worker "stopping" while it drains,
// then removes the key.

export function workerKeyPrefix() {
  return `${config.queue.prefix}:workers:`;
}

export function createWorkerId() {
  const host = os.hostname().replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 64) || 'worker';
  return `${host}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
}

export function startHeartbeat({
  connection,
  getActiveJobs,
  workerId = createWorkerId(),
  intervalMs = config.heartbeat.intervalMs,
  concurrency = config.concurrency,
}) {
  const key = `${workerKeyPrefix()}${workerId}`;
  const startedAt = new Date().toISOString();
  let status = 'running';
  let lastWarning = 0;

  async function beat() {
    const now = new Date();
    const value = JSON.stringify({
      id: workerId,
      hostname: os.hostname(),
      pid: process.pid,
      status,
      startedAt,
      lastHeartbeat: now.toISOString(),
      activeJobs: getActiveJobs(),
      concurrency,
      queue: config.queue.name,
    });
    try {
      await connection.set(key, value, 'PX', intervalMs * 3);
      lastHeartbeat.set(now.getTime() / 1000);
    } catch (err) {
      if (Date.now() - lastWarning > 60000) {
        lastWarning = Date.now();
        logger.warn('heartbeat_failed', { workerId, err });
      }
    }
  }

  const timer = setInterval(beat, intervalMs);
  timer.unref();
  const ready = beat();

  return {
    workerId,
    ready,
    beat,
    // Draining: still alive, taking no new jobs.
    async markStopping() {
      status = 'stopping';
      await beat();
    },
    async stop() {
      clearInterval(timer);
      await connection.del(key).catch(() => {});
    },
  };
}
