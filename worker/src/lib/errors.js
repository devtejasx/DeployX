import { UnrecoverableError } from 'bullmq';

// A deployment that failed for good and whose failure is already recorded in
// full (status, error message, rollback outcome and logs) by the code that
// raised it. Being an UnrecoverableError, it ends the job without a retry;
// the processor passes it on without recording the failure a second time.
export class RecordedFailureError extends UnrecoverableError {}
