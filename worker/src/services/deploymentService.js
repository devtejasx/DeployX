import { UnrecoverableError } from 'bullmq';
import { query } from '../db/postgres.js';
import { publishLog, publishStatus } from '../events/deploymentEvents.js';
import { recordDeploymentOutcome, rollbacks } from '../lib/metrics.js';
import { logger } from '../lib/logger.js';

// Final statuses: a deployment in one of them is never changed again.
export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'ROLLBACK_FAILED'];

// SQLSTATE raised by the database state machine for a transition that is not
// in deployment_status_transitions (see the API's migration 1790671094193).
const INVALID_TRANSITION = 'DX001';

function invalidTransition(err) {
  const { from, to } = JSON.parse(err.detail);
  // Retrying cannot make it valid (e.g. the deployment was set to FAILED by
  // hand while the job ran), so the job ends without further attempts.
  return new UnrecoverableError(`Invalid deployment state transition: ${from} -> ${to}`);
}

const DEPLOYMENT_COLUMNS = `id, project_id, commit_sha, branch, status, trigger, deployment_target,
  docker_image, docker_image_id, image_digest,
  container_id, container_name, host_port, container_removed_at, aws_task_definition_arn, error_message,
  health_check, rollback_status, rollback_deployment_id,
  started_at, finished_at, created_at, updated_at`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Log messages are capped to fit deployment_logs (and to stay readable).
const MAX_LOG_LENGTH = 4000;
const MAX_ERROR_LENGTH = 2000;
const LOG_RETURNING = 'RETURNING id, level, message, created_at';

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 14)}… [truncated]` : text;
}

// The deployment plus the project fields the pipeline needs, or null if the
// deployment no longer exists (e.g. its project was deleted while queued).
export async function getDeploymentWithProject(deploymentId) {
  const { rows } = await query(
    `SELECT d.*,
            json_build_object(
              'id', p.id, 'name', p.name, 'github_repo', p.github_repo,
              'dockerfile_path', p.dockerfile_path, 'container_port', p.container_port,
              'health_check_path', p.health_check_path,
              'aws_ecs_service', p.aws_ecs_service, 'aws_service_url', p.aws_service_url
            ) AS project
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1`,
    [deploymentId],
  );
  return rows[0] ?? null;
}

// The worker's only way to change a deployment's status. It goes through the
// database state machine (transition_deployment_status), which rejects
// transitions that are not allowed and keeps the timestamps right. In the
// same statement `message` is appended to the logs, so nobody can observe the
// new status without its log line. Both are then published as real-time
// events (log first, then status).
// Returns the updated deployment, or null if it no longer exists.
export async function transitionDeploymentStatus(deploymentId, status, { message = null, level = 'INFO' } = {}) {
  try {
    const { rows } = await query(
      `WITH updated AS (
         SELECT ${DEPLOYMENT_COLUMNS} FROM transition_deployment_status($1, $2)
       ), logged AS (
         INSERT INTO deployment_logs (deployment_id, level, message)
         SELECT id, $3, $4 FROM updated WHERE $4::text IS NOT NULL
         ${LOG_RETURNING}
       )
       SELECT updated.*, (SELECT row_to_json(logged) FROM logged) AS log FROM updated`,
      [deploymentId, status, level, message === null ? null : clip(message, MAX_LOG_LENGTH)],
    );
    if (rows.length === 0) return null;
    const { log, ...deployment } = rows[0];
    await publishLog(deploymentId, log);
    await publishStatus(deploymentId, deployment.status);
    if (TERMINAL_STATUSES.includes(deployment.status)) recordDeploymentOutcome(deployment);
    else logger.info('deployment_status_changed', { deploymentId, projectId: deployment.project_id, status: deployment.status });
    return deployment;
  } catch (err) {
    if (err.code === INVALID_TRANSITION) throw invalidTransition(err);
    throw err;
  }
}

// Moves the deployment to FAILED (with its error message) through the state
// machine unless it already reached a final state, logging `message` in the
// same statement. `status` can be ROLLBACK_FAILED instead, for a deployment
// whose rollback did not succeed. Returns true if this call changed it, so
// the failure is logged exactly once.
export async function markFailed(deploymentId, errorMessage, message, { status = 'FAILED' } = {}) {
  try {
    const { rows } = await query(
      `WITH current AS (
         SELECT id FROM deployments WHERE id = $1 AND status <> ALL($4::varchar[])
       ), updated AS (
         SELECT t.id, t.project_id, t.status, t.deployment_target, t.started_at, t.created_at, t.finished_at, t.error_message
         FROM current CROSS JOIN LATERAL transition_deployment_status(current.id, $5, $2) AS t
       ), logged AS (
         INSERT INTO deployment_logs (deployment_id, level, message)
         SELECT id, 'ERROR', $3 FROM updated
         ${LOG_RETURNING}
       )
       SELECT updated.*, (SELECT row_to_json(logged) FROM logged) AS log FROM updated`,
      [deploymentId, clip(errorMessage, MAX_ERROR_LENGTH), clip(message, MAX_LOG_LENGTH), TERMINAL_STATUSES, status],
    );
    if (rows.length === 0) return false;
    const { log, ...deployment } = rows[0];
    await publishLog(deploymentId, log);
    await publishStatus(deploymentId, status);
    recordDeploymentOutcome(deployment);
    return true;
  } catch (err) {
    // It reached a final state concurrently: nothing to mark.
    if (err.code === INVALID_TRANSITION) return false;
    throw err;
  }
}

// Appends a log line through the same deployment_logs table the API serves,
// then publishes it as a real-time event. A deployment that has been deleted
// is silently skipped.
export async function addLog(deploymentId, level, message) {
  const { rows } = await query(
    `INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, $2, $3 FROM deployments WHERE id = $1
     ${LOG_RETURNING}`,
    [deploymentId, level, clip(message, MAX_LOG_LENGTH)],
  );
  await publishLog(deploymentId, rows[0]);
}

// Stores the exact commit that was checked out (fills it in when the
// deployment was requested without a commit SHA).
export async function recordCommit(deploymentId, commitSha) {
  await query('UPDATE deployments SET commit_sha = $2 WHERE id = $1', [deploymentId, commitSha]);
}

// The image the deployment was built as: its tag, and its immutable ID when
// known (what a rollback starts the deployment from again).
export async function recordImage(deploymentId, image, imageId = null) {
  await query('UPDATE deployments SET docker_image = $2, docker_image_id = $3 WHERE id = $1', [
    deploymentId,
    image,
    imageId,
  ]);
}

// The image as pushed to a registry (AWS_ECS): docker_image becomes its
// registry reference (<repository-uri>:<tag>), image_digest the immutable
// digest ECS runs and a rollback restores.
export async function recordRegistryImage(deploymentId, reference, digest) {
  await query('UPDATE deployments SET docker_image = $2, image_digest = $3 WHERE id = $1', [
    deploymentId,
    reference,
    digest,
  ]);
}

// The ECS task definition revision the deployment runs as (AWS_ECS).
export async function recordTaskDefinition(deploymentId, taskDefinitionArn) {
  await query('UPDATE deployments SET aws_task_definition_arn = $2 WHERE id = $1', [deploymentId, taskDefinitionArn]);
}

export async function recordContainer(deploymentId, { containerId, containerName, hostPort }) {
  await query(
    `UPDATE deployments
     SET container_id = $2, container_name = $3, host_port = $4, container_removed_at = NULL
     WHERE id = $1`,
    [deploymentId, containerId, containerName, hostPort],
  );
}

// The project's last stable deployment: its most recently finished SUCCESS
// deployment (stable_deployment_id() in PostgreSQL, the definition the API
// reports as is_stable), or null if the project never had one.
export async function findStableDeployment(projectId) {
  const { rows } = await query(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = stable_deployment_id($1)`,
    [projectId],
  );
  return rows[0] ?? null;
}

// Of `deploymentIds`, the ones a job is still working on (no final status yet).
export async function unfinishedDeploymentIds(deploymentIds) {
  const ids = deploymentIds.filter((id) => UUID_PATTERN.test(id ?? ''));
  if (ids.length === 0) return new Set();
  const { rows } = await query(
    'SELECT id FROM deployments WHERE id = ANY($1::uuid[]) AND status <> ALL($2::varchar[])',
    [ids, TERMINAL_STATUSES],
  );
  return new Set(rows.map((row) => row.id));
}

// Health-check details of the deployment (deployments.health_check, one JSON
// object): `details` is merged into what is stored, or replaces it when a new
// health check starts (`reset`).
//   { status: 'RUNNING' | 'PASSED' | 'FAILED', attempts, max_attempts,
//     status_code, response_time, error, started_at, completed_at }
export async function recordHealthCheck(deploymentId, details, { reset = false } = {}) {
  await query(
    `UPDATE deployments
     SET health_check = CASE WHEN $3 THEN $2::jsonb ELSE COALESCE(health_check, '{}'::jsonb) || $2::jsonb END
     WHERE id = $1`,
    [deploymentId, JSON.stringify(details), reset],
  );
}

// Outcome of the automatic rollback of an unhealthy deployment:
// COMPLETED, FAILED or NOT_AVAILABLE, and the stable deployment it targeted.
export async function recordRollback(deploymentId, { status, rollbackDeploymentId = null }) {
  rollbacks.inc({ outcome: status });
  logger.info('rollback_finished', { deploymentId, outcome: status, rollbackDeploymentId });
  await query('UPDATE deployments SET rollback_status = $2, rollback_deployment_id = $3 WHERE id = $1', [
    deploymentId,
    status,
    rollbackDeploymentId,
  ]);
}

// The deployment's container was removed (e.g. replaced by a newer
// deployment). The deployment row and its logs are kept as history.
export async function recordContainerRemoved(deploymentId, message) {
  const { rows } = await query(
    `WITH updated AS (
       UPDATE deployments SET container_removed_at = now()
       WHERE id = $1 AND container_removed_at IS NULL
       RETURNING id
     )
     INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, 'INFO', $2 FROM updated
     ${LOG_RETURNING}`,
    [deploymentId, clip(message, MAX_LOG_LENGTH)],
  );
  await publishLog(deploymentId, rows[0]);
}
