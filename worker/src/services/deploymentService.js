import { query } from '../db/postgres.js';

export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED'];

const DEPLOYMENT_COLUMNS = `id, project_id, commit_sha, branch, status, docker_image,
  container_id, container_name, host_port, container_removed_at, error_message,
  started_at, finished_at, created_at, updated_at`;

// Log messages are capped to fit deployment_logs (and to stay readable).
const MAX_LOG_LENGTH = 4000;
const MAX_ERROR_LENGTH = 2000;

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
              'dockerfile_path', p.dockerfile_path, 'container_port', p.container_port
            ) AS project
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1`,
    [deploymentId],
  );
  return rows[0] ?? null;
}

// Sets the status and, in the same statement, appends `message` to the logs,
// so nobody can observe the new status without its log line. Timestamps:
// - started_at: set the first time work begins, then kept (also across retries)
// - finished_at: set on SUCCESS/FAILED, cleared otherwise
// Returns the updated deployment, or null if it no longer exists.
export async function setStatus(deploymentId, status, message = null, level = 'INFO') {
  const { rows } = await query(
    `WITH updated AS (
       UPDATE deployments
       SET status = $2::varchar,
           started_at = CASE
             WHEN $2::varchar IN ('BUILDING', 'DEPLOYING', 'HEALTH_CHECK') THEN COALESCE(started_at, now())
             ELSE started_at
           END,
           finished_at = CASE WHEN $2::varchar IN ('SUCCESS', 'FAILED') THEN now() ELSE NULL END,
           error_message = NULL
       WHERE id = $1
       RETURNING ${DEPLOYMENT_COLUMNS}
     ), logged AS (
       INSERT INTO deployment_logs (deployment_id, level, message)
       SELECT id, $3, $4 FROM updated WHERE $4::text IS NOT NULL
     )
     SELECT * FROM updated`,
    [deploymentId, status, level, message === null ? null : clip(message, MAX_LOG_LENGTH)],
  );
  return rows[0] ?? null;
}

// Marks the deployment FAILED (with its error message) unless it already
// reached a final state, logging `message` in the same statement. Returns
// true if this call changed it, so the failure is logged exactly once.
export async function markFailed(deploymentId, errorMessage, message) {
  const { rows } = await query(
    `WITH updated AS (
       UPDATE deployments
       SET status = 'FAILED', finished_at = now(), error_message = $2
       WHERE id = $1 AND status NOT IN ('SUCCESS', 'FAILED')
       RETURNING id
     ), logged AS (
       INSERT INTO deployment_logs (deployment_id, level, message)
       SELECT id, 'ERROR', $3 FROM updated
     )
     SELECT id FROM updated`,
    [deploymentId, clip(errorMessage, MAX_ERROR_LENGTH), clip(message, MAX_LOG_LENGTH)],
  );
  return rows.length > 0;
}

// Appends a log line through the same deployment_logs table the API serves.
// A deployment that has been deleted is silently skipped.
export async function addLog(deploymentId, level, message) {
  await query(
    `INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, $2, $3 FROM deployments WHERE id = $1`,
    [deploymentId, level, clip(message, MAX_LOG_LENGTH)],
  );
}

// Stores the exact commit that was checked out (fills it in when the
// deployment was requested without a commit SHA).
export async function recordCommit(deploymentId, commitSha) {
  await query('UPDATE deployments SET commit_sha = $2 WHERE id = $1', [deploymentId, commitSha]);
}

export async function recordImage(deploymentId, image) {
  await query('UPDATE deployments SET docker_image = $2 WHERE id = $1', [deploymentId, image]);
}

export async function recordContainer(deploymentId, { containerId, containerName, hostPort }) {
  await query(
    `UPDATE deployments
     SET container_id = $2, container_name = $3, host_port = $4, container_removed_at = NULL
     WHERE id = $1`,
    [deploymentId, containerId, containerName, hostPort],
  );
}

// The deployment's container was removed (e.g. replaced by a newer
// deployment). The deployment row and its logs are kept as history.
export async function recordContainerRemoved(deploymentId, message) {
  await query(
    `WITH updated AS (
       UPDATE deployments SET container_removed_at = now()
       WHERE id = $1 AND container_removed_at IS NULL
       RETURNING id
     )
     INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, 'INFO', $2 FROM updated`,
    [deploymentId, clip(message, MAX_LOG_LENGTH)],
  );
}
