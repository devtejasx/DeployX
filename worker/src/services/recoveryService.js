import { Queue } from 'bullmq';
import config from '../config/index.js';
import pool from '../db/postgres.js';
import { logger } from '../lib/logger.js';
import { stuckDeploymentsRecovered } from '../lib/metrics.js';
import { markFailed, recordRollback } from './deploymentService.js';

// Recovery of deployments that would otherwise stay unfinished forever.
//
// PostgreSQL is the source of truth; Redis only holds the work queue. If a
// deployment is QUEUED, BUILDING, DEPLOYING, HEALTH_CHECK or ROLLING_BACK but
// its BullMQ job is gone (Redis lost its data, the job was removed by hand) or
// already over (the final failure could not be written because PostgreSQL was
// down), nothing will ever move it again. Every interval, one worker (a
// PostgreSQL advisory lock decides which) looks at deployments unchanged for
// STUCK_DEPLOYMENT_AFTER_MS:
//
//   job waiting / delayed / active  -> left alone: it is genuinely queued or
//                                      running (a hung attempt is ended by
//                                      DEPLOYMENT_TIMEOUT_MS, a dead worker's
//                                      job by BullMQ's stalled-job check)
//   job missing / completed / failed -> FAILED (ROLLBACK_FAILED when it was
//                                      rolling back), with the reason logged
//
// Nothing is retried automatically: the deployment can be started again.

const LIVE_JOB_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children', 'paused']);
const UNFINISHED = ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK'];
const LOCK_KEY = 'deployx:stuck-deployment-recovery';

export function createRecoveryService({
  connection,
  staleAfterMs = config.recovery.staleAfterMs,
  queue = new Queue(config.queue.name, { connection, prefix: config.queue.prefix }),
} = {}) {
  async function jobState(deploymentId) {
    const job = await queue.getJob(deploymentId);
    return job ? job.getState() : 'missing';
  }

  // One pass. Returns the deployments it ended: [{ id, status, jobState }],
  // or null when another worker is doing the pass.
  async function recoverStuckDeployments() {
    const client = await pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [LOCK_KEY])).rows[0].locked;
      if (!locked) return null;

      const { rows } = await client.query(
        `SELECT id, project_id, status, updated_at, rollback_deployment_id FROM deployments
         WHERE status = ANY($1::varchar[]) AND updated_at < now() - make_interval(secs => $2)
         ORDER BY updated_at
         LIMIT 100`,
        [UNFINISHED, staleAfterMs / 1000],
      );

      const recovered = [];
      for (const deployment of rows) {
        const state = await jobState(deployment.id);
        if (LIVE_JOB_STATES.has(state)) continue;

        const reason =
          state === 'missing'
            ? 'its job is no longer in the queue (Redis data lost or the job was removed)'
            : `its job already ended (${state}) without the deployment being finished`;
        const rollingBack = deployment.status === 'ROLLING_BACK';
        if (rollingBack) {
          await recordRollback(deployment.id, { status: 'FAILED', rollbackDeploymentId: deployment.rollback_deployment_id });
        }
        const changed = await markFailed(
          deployment.id,
          `Deployment stopped making progress in ${deployment.status}: ${reason}`,
          `Deployment marked ${rollingBack ? 'ROLLBACK_FAILED' : 'FAILED'} by the recovery check: ${reason}. Start a new deployment to try again.`,
          { status: rollingBack ? 'ROLLBACK_FAILED' : 'FAILED' },
        );
        if (changed) {
          stuckDeploymentsRecovered.inc({ status: deployment.status });
          logger.warn('stuck_deployment_recovered', {
            deploymentId: deployment.id,
            projectId: deployment.project_id,
            status: deployment.status,
            jobState: state,
          });
          recovered.push({ id: deployment.id, status: deployment.status, jobState: state });
        }
      }
      return recovered;
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY]).catch(() => {});
      client.release();
    }
  }

  let timer = null;
  let running = null;

  async function tick() {
    if (running) return;
    running = recoverStuckDeployments()
      .catch((err) => logger.warn('recovery_check_failed', { err }))
      .finally(() => {
        running = null;
      });
    await running;
  }

  return {
    recoverStuckDeployments,
    start(intervalMs = config.recovery.intervalMs) {
      timer = setInterval(tick, intervalMs);
      timer.unref();
      tick();
    },
    async stop() {
      clearInterval(timer);
      await running;
      await queue.close();
    },
  };
}
