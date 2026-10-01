import { query } from '../db/postgres.js';
import { publishLog } from '../events/deploymentEvents.js';
import { ApiError } from '../utils/ApiError.js';
import { getDeployment } from './deployment.service.js';

const LOG_COLUMNS = 'id, deployment_id, level, message, created_at';

// Most lines read per query by live streams.
export const LOG_BATCH_SIZE = 500;

// ADMIN only (routes/log.routes.js): the platform writes deployment logs
// itself; this endpoint is an operator tool. Inserts only if the deployment
// still exists, then publishes the line to live log streams.
export async function addLog(user, deploymentId, { level, message }) {
  await getDeployment(user, deploymentId);
  const { rows } = await query(
    `INSERT INTO deployment_logs (deployment_id, level, message)
     SELECT id, $2, $3 FROM deployments WHERE id = $1
     RETURNING ${LOG_COLUMNS}`,
    [deploymentId, level, message],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Deployment not found');
  }
  await publishLog(deploymentId, rows[0]);
  return rows[0];
}

// Lines written after log `afterId` (a bigint as a decimal string), oldest
// first, at most LOG_BATCH_SIZE. Used by live streams, which check ownership
// once when they open.
export async function listLogsAfter(deploymentId, afterId) {
  const { rows } = await query(
    `SELECT ${LOG_COLUMNS} FROM deployment_logs
     WHERE deployment_id = $1 AND id > $2::bigint
     ORDER BY id
     LIMIT ${LOG_BATCH_SIZE}`,
    [deploymentId, afterId],
  );
  return rows;
}

// Chronological order. The identity id breaks ties between log lines written
// within the same timestamp.
export async function listLogs(user, deploymentId) {
  await getDeployment(user, deploymentId);

  const { rows } = await query(
    `SELECT ${LOG_COLUMNS} FROM deployment_logs WHERE deployment_id = $1 ORDER BY id`,
    [deploymentId],
  );
  return rows;
}
