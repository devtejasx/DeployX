import { query } from '../db/postgres.js';
import { ApiError } from '../utils/ApiError.js';
import { getDeployment } from './deployment.service.js';

const LOG_COLUMNS = 'id, deployment_id, level, message, created_at';

// Inserts only if the deployment exists and belongs to the user, in one statement.
export async function addLog(userId, deploymentId, { level, message }) {
  const { rows } = await query(
    `INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT d.id, $3, $4
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1 AND p.user_id = $2
     RETURNING ${LOG_COLUMNS}`,
    [deploymentId, userId, level, message],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Deployment not found');
  }
  return rows[0];
}

// Chronological order. The identity id breaks ties between log lines written
// within the same timestamp.
export async function listLogs(userId, deploymentId) {
  await getDeployment(userId, deploymentId);

  const { rows } = await query(
    `SELECT ${LOG_COLUMNS} FROM deployment_logs WHERE deployment_id = $1 ORDER BY id`,
    [deploymentId],
  );
  return rows;
}
