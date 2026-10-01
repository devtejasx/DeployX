import { beginShutdown } from './lifecycle.js';
import { logger } from './logger.js';

// The API's graceful shutdown, in order:
//   1. readiness turns 503, so load balancers stop sending new requests
//   2. the HTTP server stops accepting connections; idle keep-alive ones close
//   3. live log streams end (browsers reconnect to another instance)
//   4. running requests finish
//   5. background timers stop, then the event subscriber, the queue, and
//      finally PostgreSQL and Redis close
//   6. exit(0)
// If that takes longer than `timeoutMs`, exit(1) anyway. The API holds no
// deployment state of its own (PostgreSQL and the queue do), so nothing is
// left half-written. Every dependency is passed in, so tests can drive it.
export function createShutdown({
  server,
  timeoutMs,
  stopTimers = () => {},
  closeStreams = () => {},
  closeSubscriber = async () => {},
  closeQueue = async () => {},
  closeConnections = async () => {},
  exit = (code) => process.exit(code),
}) {
  let stopping = null;

  return function shutdown(signal) {
    if (stopping) return stopping;
    beginShutdown();
    logger.info('api_stopping', { signal });

    const forceExit = setTimeout(() => {
      logger.error('api_shutdown_timeout', { timeoutMs });
      exit(1);
    }, timeoutMs);
    forceExit.unref?.();

    stopping = (async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      stopTimers();
      closeStreams();
      await closed;
      await closeSubscriber().catch(() => {});
      // The queue uses the shared Redis connection, so it closes first.
      await closeQueue().catch(() => {});
      await closeConnections().catch(() => {});
      clearTimeout(forceExit);
      logger.info('api_stopped');
      exit(0);
    })();
    return stopping;
  };
}
