// Process lifecycle shared by the readiness check and server.js: once a
// shutdown has begun, the API reports itself not ready so load balancers stop
// sending it new requests while running ones finish.
let shuttingDown = false;

export function beginShutdown() {
  shuttingDown = true;
}

export function isShuttingDown() {
  return shuttingDown;
}

// For tests.
export function resetLifecycle() {
  shuttingDown = false;
}
