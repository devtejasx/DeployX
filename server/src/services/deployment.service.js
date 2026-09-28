import { query } from '../db/postgres.js';
import { enqueueDeployment } from '../queues/deploymentQueue.js';
import { ApiError } from '../utils/ApiError.js';
import { getProject } from './project.service.js';

const DEPLOYMENT_COLUMNS = `d.id, d.project_id, d.commit_sha, d.branch, d.status, d.docker_image,
  d.container_id, d.container_name, d.host_port, d.container_removed_at, d.error_message,
  d.started_at, d.finished_at, d.created_at, d.updated_at`;

// A single deployment, with a summary of the project it belongs to.
const DEPLOYMENT_DETAIL_COLUMNS = `${DEPLOYMENT_COLUMNS},
  json_build_object('id', p.id, 'name', p.name, 'github_repo', p.github_repo) AS project`;

// Log lines written by the platform itself (not submitted through the API).
async function appendLog(deploymentId, level, message) {
  await query('INSERT INTO deployment_logs (deployment_id, level, message) VALUES ($1, $2, $3)', [
    deploymentId,
    level,
    message,
  ]);
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
    await query(
      `UPDATE deployments SET status = 'FAILED', finished_at = now() WHERE id = $1`,
      [deployment.id],
    );
    await appendLog(deployment.id, 'ERROR', 'Could not add the deployment job to the queue (Redis unavailable)');
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

// Records a status change and keeps the timestamps consistent with it:
// - started_at is set the first time the deployment leaves QUEUED
// - finished_at is set on SUCCESS/FAILED and cleared otherwise
// Which transitions are allowed is not enforced yet (a later phase). The
// worker drives the status while it processes a job; this is a manual
// override and is not coordinated with a job that is currently running.
export async function updateDeploymentStatus(userId, deploymentId, status) {
  const { rows } = await query(
    `WITH d AS (
       UPDATE deployments AS dep
       SET status = $3::varchar,
           started_at = CASE
             WHEN $3::varchar = 'QUEUED' THEN NULL
             ELSE COALESCE(dep.started_at, now())
           END,
           finished_at = CASE
             WHEN $3::varchar IN ('SUCCESS', 'FAILED') THEN now()
             ELSE NULL
           END
       FROM projects AS owner
       WHERE dep.id = $1 AND owner.id = dep.project_id AND owner.user_id = $2
       RETURNING dep.*
     )
     SELECT ${DEPLOYMENT_DETAIL_COLUMNS} FROM d JOIN projects p ON p.id = d.project_id`,
    [deploymentId, userId, status],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Deployment not found');
  }
  return rows[0];
}
