import config from '../config/index.js';
import { withProjectLock } from '../db/postgres.js';
import { RecordedFailureError } from '../lib/errors.js';
import * as dockerService from '../services/dockerService.js';
import { recordHealthCheck } from '../services/deploymentService.js';
import { maxHealthCheckAttempts, waitForHealthy } from '../services/healthCheckService.js';
import { createRollbackService } from '../services/rollbackService.js';
import { createLocalDockerTarget } from '../targets/localDockerTarget.js';

// Lines of the unhealthy version's output copied into the deployment logs.
const CONTAINER_LOG_LINES = 20;

// The last stage of a deployment, once its new version runs, for every
// deployment target:
//
//   HEALTH_CHECK ── healthy ──> SUCCESS   (then the previous version is retired)
//        │
//        └── unhealthy ──> ROLLING_BACK ──> FAILED            (last stable version restored)
//                     │                └──> ROLLBACK_FAILED   (it could not be restored)
//                     └──> FAILED                             (no stable version to restore)
//
// A deployment is never SUCCESS because its version started: only a passed
// health check leads there. The previous stable version keeps running until
// then (LOCAL), or is restored by the rollback (AWS_ECS).
//
// `target` is the deployment target (by default LOCAL on `docker`, the Docker
// service, which tests replace by a fake). `lock` serializes promotion and
// rollback per project; a target that already serializes whole deployments
// (AWS_ECS) passes one that does not lock again.
export function createRelease({
  docker = dockerService,
  target = createLocalDockerTarget({ docker }),
  lock = withProjectLock,
} = {}) {
  const rollbackDeployment = createRollbackService({ target });

  // `deployed`: what target.deploy() returned for the deployment (LOCAL:
  // { containerId, name, hostPort, image }). Returns the job result on
  // SUCCESS; throws RecordedFailureError after an unhealthy deployment was
  // handled.
  return async function release(ctx, deployed) {
    const { deployment, project } = ctx;
    const { timeoutMs, intervalMs } = config.healthCheck;
    const maxAttempts = maxHealthCheckAttempts();
    const path = project.health_check_path;
    const health = target.healthCheck(deployed);

    // The details are stored before the line (or status) that announces them,
    // so whoever reads the deployment because of that event sees them.
    await recordHealthCheck(
      deployment.id,
      {
        status: 'RUNNING',
        attempts: 0,
        max_attempts: maxAttempts,
        status_code: null,
        response_time: null,
        error: null,
        started_at: new Date().toISOString(),
        completed_at: null,
      },
      { reset: true },
    );
    await ctx.setStage(
      'HEALTH_CHECK',
      `Running health checks: GET ${health.url}${path} ` +
        `(up to ${maxAttempts} attempts, ${timeoutMs / 1000}s timeout, ${intervalMs / 1000}s apart)`,
    );
    const result = await waitForHealthy({
      ...health.options,
      path,
      onLog: ctx.log,
      onAttempt: ({ attempt, result: attemptResult }) =>
        recordHealthCheck(deployment.id, {
          attempts: attempt,
          status_code: attemptResult.statusCode ?? null,
          response_time: attemptResult.responseTime ?? null,
          error: attemptResult.healthy ? null : attemptResult.error,
          ...(attemptResult.healthy ? { status: 'PASSED', completed_at: new Date().toISOString() } : {}),
        }),
    });

    if (result.healthy) {
      // Promotion and rollback of one project never run at the same time.
      return lock(project.id, async () => {
        await ctx.setStage('SUCCESS', 'Deployment completed successfully');
        await target.retirePrevious(ctx, deployed);
        return { status: 'SUCCESS', ...deployed };
      });
    }

    const reason = `Health check failed after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'}: ${result.error}`;
    await recordHealthCheck(deployment.id, { status: 'FAILED', completed_at: new Date().toISOString() });
    await ctx.log('ERROR', reason);
    const output = await Promise.resolve()
      .then(() => target.logs(deployed, CONTAINER_LOG_LINES))
      .catch(() => []);
    for (const line of output) await ctx.log('INFO', `[container] ${line.slice(0, 1000)}`);
    await ctx.log('ERROR', 'Deployment marked unhealthy');

    const outcome = await lock(project.id, () => rollbackDeployment(ctx, { deployed, reason }));
    // Rebuilding the same commit cannot make it healthy: no retry.
    throw new RecordedFailureError(outcome.errorMessage);
  };
}
