import { query } from '../db/postgres.js';
import { publishLog, publishStatus } from '../events/deploymentEvents.js';
import { enqueueDeployment } from '../queues/deploymentQueue.js';
import { ApiError } from '../utils/ApiError.js';
import { transitionDeploymentStatus } from './deploymentStateMachine.js';
import { getProject } from './project.service.js';

const DEPLOYMENT_COLUMNS = `d.id, d.project_id, d.commit_sha, d.branch, d.status, d.docker_image,
  d.container_id, d.container_name, d.host_port, d.container_removed_at, d.error_message,
  d.started_at, d.finished_at, d.created_at, d.updated_at`;

// A single deployment, with a summary of the project it belongs to.
const DEPLOYMENT_DETAIL_COLUMNS = `${DEPLOYMENT_COLUMNS},
  json_build_object('id', p.id, 'name', p.name, 'github_repo', p.github_repo) AS project`;

// Log lines written by the platform itself (not submitted through the API),
// persisted first and then published as real-time events.
async function appendLog(deploymentId, level, message) {
  const { rows } = await query(
    `INSERT INTO deployment_logs (deployment_id, level, message) VALUES ($1, $2, $3)
     RETURNING id, level, message, created_at`,
    [deploymentId, level, message],
  );
  await publishLog(deploymentId, rows[0]);
}

// Creates the QUEUED record and hands it to the job queue. The API returns as
// soon as the job is stored in Redis; the worker does the actual processing.
export async function createDeployment(userId, projectId, data) {
  const project = await getProject(userId, projectId);

  if (project.status !== 'ACTIVE') {
    throw ApiError.conflict('Project is inactive; set its status to ACTIVE before deploying');
  }

  const { rows } = await query(
    `WITH d AS (
       INSERT INTO deployments (project_id, commit_sha, branch, status)
       VALUES ($1, $2, $3, 'QUEUED')
       RETURNING *
     )
     SELECT ${DEPLOYMENT_DETAIL_COLUMNS} FROM d JOIN projects p ON p.id = d.project_id`,
    [project.id, data.commit_sha ?? null, data.branch ?? project.github_branch],
  );
  const deployment = rows[0];
  await appendLog(deployment.id, 'INFO', 'Deployment created');

  let job;
  try {
    job = await enqueueDeployment(deployment);
  } catch (err) {
    // Without a job nothing would ever pick the deployment up, so record the
    // failure instead of leaving it QUEUED forever.
    console.error(`[api] Could not queue deployment ${deployment.id}:`, err.message || err);
    await transitionDeploymentStatus(deployment.id, 'FAILED', { errorMessage: 'Deployment queue is unavailable' });
    await appendLog(deployment.id, 'ERROR', 'Could not add the deployment job to the queue (Redis unavailable)');
    await publishStatus(deployment.id, 'FAILED');
    throw new ApiError(503, 'Deployment queue is unavailable; the deployment was marked as FAILED');
  }

  return { deployment, jobId: job.id };
}

// Newest first.
export async function listProjectDeployments(userId, projectId) {
  await getProject(userId, projectId);

  const { rows } = await query(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
     WHERE d.project_id = $1
     ORDER BY d.created_at DESC, d.id`,
    [projectId],
  );
  return rows;
}

export async function getDeployment(userId, deploymentId) {
  const { rows } = await query(
    `SELECT ${DEPLOYMENT_DETAIL_COLUMNS}
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1 AND p.user_id = $2`,
    [deploymentId, userId],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Deployment not found');
  }
  return rows[0];
}

// Manual status change through the state machine: only transitions listed
// in deployment_status_transitions are accepted (409 otherwise), and the
// timestamps follow the database rules. The worker drives the status while
// it processes a job; this override is not coordinated with a running job.
export async function updateDeploymentStatus(userId, deploymentId, status) {
  const before = await getDeployment(userId, deploymentId); // 404 unless it exists and is the user's
  await transitionDeploymentStatus(deploymentId, status);
  if (before.status !== status) await publishStatus(deploymentId, status);
  return getDeployment(userId, deploymentId);
}
