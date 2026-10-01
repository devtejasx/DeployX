import client from 'prom-client';
import { logger } from './logger.js';

// Prometheus metrics of the worker, served on WORKER_METRICS_PORT
// (monitoringServer.js). Counted where things happen, in the process that
// did them: Prometheus sums them over every worker.

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'deployx-worker' });
client.collectDefaultMetrics({ register: registry, prefix: 'deployx_worker_' });

export const deploymentsSucceeded = new client.Counter({
  name: 'deployx_deployments_success_total',
  help: 'Deployments that ended SUCCESS (health check passed)',
  labelNames: ['target'],
  registers: [registry],
});

export const deploymentsFailed = new client.Counter({
  name: 'deployx_deployments_failed_total',
  help: 'Deployments that ended FAILED or ROLLBACK_FAILED',
  labelNames: ['status', 'target'],
  registers: [registry],
});

export const rollbacks = new client.Counter({
  name: 'deployx_deployments_rollback_total',
  help: 'Automatic rollbacks of unhealthy deployments, by outcome (COMPLETED, FAILED, NOT_AVAILABLE)',
  labelNames: ['outcome'],
  registers: [registry],
});

export const deploymentDuration = new client.Histogram({
  name: 'deployx_deployment_duration_seconds',
  help: 'Time from the first attempt starting to the final status',
  labelNames: ['status', 'target'],
  buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  registers: [registry],
});

export const healthCheckFailures = new client.Counter({
  name: 'deployx_health_check_failures_total',
  help: 'Failed health-check attempts (each attempt counts once)',
  registers: [registry],
});

export const jobsActive = new client.Gauge({
  name: 'deployx_worker_jobs_active',
  help: 'Deployment jobs this worker is running right now',
  registers: [registry],
});

export const jobsCompleted = new client.Counter({
  name: 'deployx_worker_jobs_completed_total',
  help: 'Jobs that ended without an error (including skipped ones)',
  registers: [registry],
});

export const jobsFailed = new client.Counter({
  name: 'deployx_worker_jobs_failed_total',
  help: 'Job attempts that ended with an error, by whether BullMQ retries them',
  labelNames: ['final'],
  registers: [registry],
});

export const deploymentTimeouts = new client.Counter({
  name: 'deployx_deployment_timeouts_total',
  help: 'Deployments stopped because they exceeded DEPLOYMENT_TIMEOUT_MS',
  registers: [registry],
});

export const stuckDeploymentsRecovered = new client.Counter({
  name: 'deployx_stuck_deployments_recovered_total',
  help: 'Unfinished deployments without a job that the recovery check ended',
  labelNames: ['status'],
  registers: [registry],
});

export const lastHeartbeat = new client.Gauge({
  name: 'deployx_worker_last_heartbeat_timestamp_seconds',
  help: 'When this worker last published its heartbeat (Unix time)',
  registers: [registry],
});

// A deployment reached a final status: counted, timed and logged once (the
// callers only report transitions they made themselves).
//   row: { id, project_id, status, deployment_target, started_at, finished_at, error_message }
export function recordDeploymentOutcome(row) {
  if (!row) return;
  const target = row.deployment_target ?? 'LOCAL';
  const start = row.started_at ?? row.created_at;
  const durationSeconds = start && row.finished_at ? (new Date(row.finished_at) - new Date(start)) / 1000 : null;
  if (row.status === 'SUCCESS') deploymentsSucceeded.inc({ target });
  else deploymentsFailed.inc({ status: row.status, target });
  if (durationSeconds !== null && durationSeconds >= 0) {
    deploymentDuration.observe({ status: row.status, target }, durationSeconds);
  }
  const fields = {
    deploymentId: row.id,
    projectId: row.project_id,
    status: row.status,
    target,
    durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
  };
  if (row.status === 'SUCCESS') logger.info('deployment_completed', fields);
  else logger.warn('deployment_failed', { ...fields, error: row.error_message ?? null });
}
