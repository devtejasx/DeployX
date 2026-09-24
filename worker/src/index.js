// DeployX worker entry point.
//
// Phase 1 only establishes the process: it starts, reports that it is running
// and stays alive until it is asked to stop. Job processing is added later.

const env = process.env.NODE_ENV || 'development';

console.log(`DeployX Worker started (${env}, pid ${process.pid})`);

// Keep the event loop alive; there is no work to schedule yet.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

function shutdown(signal) {
  console.log(`DeployX Worker received ${signal}, shutting down`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
