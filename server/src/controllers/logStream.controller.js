import config from '../config/index.js';
import { subscribeToDeployment } from '../events/deploymentSubscriber.js';
import * as deploymentService from '../services/deployment.service.js';
import * as logService from '../services/log.service.js';
import { logger } from '../lib/logger.js';

const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'ROLLBACK_FAILED'];
// Browsers wait this long before reconnecting a dropped stream.
const CLIENT_RETRY_MS = 3000;

// Open streams, so a shutting-down server can end them (clients reconnect).
const openStreams = new Set();

export function closeAllLogStreams() {
  for (const close of openStreams) close();
}

// Log ids are bigint; they travel as decimal strings.
function parseLogId(value) {
  return typeof value === 'string' && /^\d{1,19}$/.test(value) ? BigInt(value) : 0n;
}

// GET /api/deployments/:deploymentId/logs/stream  (Server-Sent Events)
//
//   event: log     id: <log id>   data: { id, level, message, created_at }
//   event: status                 data: <deployment, as GET /api/deployments/:id>
//   event: end                    data: { deploymentId, status }   (then the stream closes)
//
// 1. Stored logs after Last-Event-ID (all of them on a fresh connection) are
//    sent first, then the current status.
// 2. New lines follow as they happen, and a status event is sent whenever the
//    deployment record changes (its status, but also e.g. its health-check
//    progress or container). Redis events (and a
//    periodic check as a safety net) only trigger a re-read of PostgreSQL, so
//    the stream is always in database order with no gaps or duplicates, even
//    if an event is missed or Redis is down.
// 3. The stream ends once the deployment is final: SUCCESS, FAILED or
//    ROLLBACK_FAILED.
// 4. On disconnect everything is released: timers and the Redis listener.
export async function streamLogs(req, res) {
  const { user } = req;
  const { deploymentId } = req.params;

  // Checked before streaming, so unknown deployments get a normal JSON 404
  // (and other users' deployments a 403). Every later read checks again.
  await deploymentService.getDeployment(user, deploymentId);

  let lastLogId = parseLogId(req.get('Last-Event-ID') ?? req.query.lastEventId);
  let lastDeploymentSent = null;
  let closed = false;
  let syncing = false;
  let syncAgain = false;
  let subscription = null;
  let pollTimer = null;
  let heartbeatTimer = null;

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stop reverse proxies (e.g. nginx) from buffering the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: ${CLIENT_RETRY_MS}\n\n`);

  function send(event, data, id) {
    if (closed) return;
    res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    subscription?.unsubscribe();
    openStreams.delete(close);
  }

  function close() {
    cleanup();
    res.end();
  }

  // Sends every stored line newer than the last one sent.
  async function sendNewLogs() {
    for (;;) {
      const logs = await logService.listLogsAfter(deploymentId, lastLogId.toString());
      for (const log of logs) {
        send('log', log, log.id);
        lastLogId = BigInt(log.id);
      }
      if (logs.length < logService.LOG_BATCH_SIZE) break;
    }
  }

  // Sends every stored line newer than the last one sent, then the deployment
  // if anything about it changed; ends the stream on a final status.
  async function sync() {
    await sendNewLogs();

    const deployment = await deploymentService.getDeployment(user, deploymentId);
    const final = TERMINAL_STATUSES.includes(deployment.status);
    // The worker commits a final status together with the deployment's last
    // log line. If that commit landed between the two reads above, the line
    // was not there yet: read the logs once more before the stream ends.
    if (final) await sendNewLogs();

    const snapshot = JSON.stringify(deployment);
    if (snapshot !== lastDeploymentSent) {
      send('status', deployment);
      lastDeploymentSent = snapshot;
    }
    if (final) {
      send('end', { deploymentId, status: deployment.status });
      close();
    }
  }

  // Runs sync() now, or once more after the one in progress, never in parallel.
  function requestSync() {
    if (closed) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    (async () => {
      try {
        do {
          syncAgain = false;
          await sync();
        } while (syncAgain && !closed);
      } catch (err) {
        // E.g. the database is unavailable, or the project was deleted. End
        // the stream; the browser reconnects and resumes from Last-Event-ID.
        if (!closed) {
          logger.warn('log_stream_failed', { deploymentId, err });
          send('stream-error', { message: 'Log stream interrupted; reconnecting' });
          close();
        }
      } finally {
        syncing = false;
      }
    })();
  }

  openStreams.add(close);
  // The client going away (tab closed, network lost) releases everything.
  res.on('close', cleanup);

  // Subscribe before the first read, so nothing written in between is missed.
  subscription = await subscribeToDeployment(deploymentId, requestSync);
  if (closed) {
    subscription.unsubscribe();
    return;
  }
  pollTimer = setInterval(requestSync, config.logStream.pollMs);
  heartbeatTimer = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, config.logStream.heartbeatMs);
  requestSync();
}
