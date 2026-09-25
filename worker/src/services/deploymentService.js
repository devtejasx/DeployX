import { query } from '../db/postgres.js';

export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED'];

const DEPLOYMENT_COLUMNS = `id, project_id, commit_sha, branch, status, docker_image,
  started_at, finished_at, created_at, updated_at`;

// Returns the deployment, or null if it no longer exists (e.g. its project
// was deleted while the job was waiting).
export async function getDeployment(deploymentId) {
  const { rows } = await query(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [deploymentId]);
  return rows[0] ?? null;
}

// Sets the status and keeps the timestamps consistent with it:
// - started_at: set the first time work begins, then kept (also across retries)
// - finished_at: set on SUCCESS/FAILED, cleared otherwise
// Returns the updated deployment, or null if it no longer exists.
export async function setStatus(deploymentId, status) {
  const { rows } = await query(
    `UPDATE deployments
     SET status = $2::varchar,
         started_at = CASE
           WHEN $2::varchar IN ('BUILDING', 'DEPLOYING', 'HEALTH_CHECK') THEN COALESCE(started_at, now())
           ELSE started_at
         END,
         finished_at = CASE WHEN $2::varchar IN ('SUCCESS', 'FAILED') THEN now() ELSE NULL END
     WHERE id = $1
     RETURNING ${DEPLOYMENT_COLUMNS}`,
    [deploymentId, status],
  );
  return rows[0] ?? null;
}

// Marks the deployment FAILED unless it already reached a final state.
// Returns true if this call changed it, so callers can log exactly once.
export async function markFailed(deploymentId) {
  const { rowCount } = await query(
    `UPDATE deployments
     SET status = 'FAILED', finished_at = now()
     WHERE id = $1 AND status NOT IN ('SUCCESS', 'FAILED')`,
    [deploymentId],
  );
  return rowCount > 0;
}

// Appends a log line through the same deployment_logs table the API serves.
// A deployment that has been deleted is silently skipped.
export async function addLog(deploymentId, level, message) {
  await query(
    `INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, $2, $3 FROM deployments WHERE id = $1`,
    [deploymentId, level, message],
  );
}
