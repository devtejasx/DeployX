import { AsyncLocalStorage } from 'node:async_hooks';

// The deployment a piece of worker code runs for, without passing it through
// every call: the processor runs each job's pipeline inside
// runWithJobContext({ signal }), and code deep inside (runCommand, health
// checks, ECS polling) reads the job's AbortSignal with currentJobSignal().
//
// The signal aborts when the deployment exceeds DEPLOYMENT_TIMEOUT_MS. Only
// work that is already running at that moment is stopped: commands and waits
// started afterwards - the failure handling and cleanup (removing a container,
// rolling back, restoring the stable version) - run normally, each bounded by
// its own timeout.
const storage = new AsyncLocalStorage();

export function runWithJobContext(context, fn) {
  return storage.run(context, fn);
}

export function currentJobSignal() {
  return storage.getStore()?.signal ?? null;
}

// The job's signal if it has not aborted yet: what an operation starting now
// should stop on. null once the deployment has timed out (cleanup runs).
export function activeJobSignal() {
  const signal = currentJobSignal();
  return signal && !signal.aborted ? signal : null;
}

export class DeploymentTimeoutError extends Error {
  constructor(message = 'Deployment timed out') {
    super(message);
    this.name = 'DeploymentTimeoutError';
  }
}
