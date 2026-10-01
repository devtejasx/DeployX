import { query } from '../db/postgres.js';
import { publishLog, publishStatus } from '../events/deploymentEvents.js';
import { enqueueDeployment } from '../queues/deploymentQueue.js';
import { deploymentsCreated } from '../lib/metrics.js';
import { ApiError } from '../utils/ApiError.js';
import { assertAccess } from './access.js';
import { transitionDeploymentStatus } from './deploymentStateMachine.js';
import { getProject } from './project.service.js';
import { logger } from '../lib/logger.js';

// is_stable: this is the project's last stable deployment, i.e. its most
// recently finished SUCCESS deployment (stable_deployment_id() in PostgreSQL,
// the definition the worker uses to choose a rollback target).
// health_check: what the worker recorded while checking the application
// ({ status, attempts, max_attempts, status_code, response_time, error, ... }).
// trigger: MANUAL or GITHUB_PUSH. deployment_target: LOCAL or AWS_ECS, with
// image_digest and aws_task_definition_arn identifying what runs on AWS.
const DEPLOYMENT_COLUMNS = `d.id, d.project_id, d.commit_sha, d.branch, d.status, d.trigger, d.deployment_target,
  d.docker_image, d.image_digest, d.container_id, d.container_name, d.host_port, d.container_removed_at,
  d.aws_task_definition_arn, d.error_message,
  d.health_check, d.rollback_status, d.rollback_deployment_id,
  COALESCE(d.id = stable_deployment_id(d.project_id), false) AS is_stable,
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

// The one way a deployment comes into existence, whatever asked for it (the
// API or a GitHub push): the QUEUED record, its first log lines, then the job
// for the worker. Every trigger shares the same queue, worker and pipeline.
// The deployment runs on the project's deployment target as it is now.
//
// A push deployment (trigger GITHUB_PUSH) is created at most once per project
// and commit (unique index deployments_github_push_commit_key): for a commit
// that already has one, nothing is created or queued and the existing
// deployment is returned with `duplicate: true`.
//
// Returns { deployment, jobId, duplicate }.
export async function queueDeployment(project, { commitSha = null, branch, trigger = 'MANUAL', logLines = [] }) {
  const { rows } = await query(
    `WITH d AS (
       INSERT INTO deployments (project_id, commit_sha, branch, status, trigger, deployment_target)
       VALUES ($1, $2, $3, 'QUEUED', $4, $5)
       ON CONFLICT (project_id, commit_sha) WHERE trigger = 'GITHUB_PUSH' DO NOTHING
       RETURNING *
     )
     SELECT ${DEPLOYMENT_DETAIL_COLUMNS} FROM d JOIN projects p ON p.id = d.project_id`,
    [project.id, commitSha, branch, trigger, project.deployment_target],
  );

  if (rows.length === 0) {
    const existing = await query(
      `SELECT ${DEPLOYMENT_DETAIL_COLUMNS}
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.project_id = $1 AND d.commit_sha = $2 AND d.trigger = 'GITHUB_PUSH'`,
      [project.id, commitSha],
    );
    return { deployment: existing.rows[0], jobId: null, duplicate: true };
  }

  const deployment = rows[0];
  for (const line of logLines) await appendLog(deployment.id, 'INFO', line);
  await appendLog(deployment.id, 'INFO', 'Deployment created');

  let job;
  try {
    job = await enqueueDeployment(deployment);
  } catch (err) {
    // Without a job nothing would ever pick the deployment up, so record the
    // failure instead of leaving it QUEUED forever.
    logger.error('deployment_queue_failed', { deploymentId: deployment.id, projectId: project.id, err });
    await transitionDeploymentStatus(deployment.id, 'FAILED', { errorMessage: 'Deployment queue is unavailable' });
    await appendLog(deployment.id, 'ERROR', 'Could not add the deployment job to the queue (Redis unavailable)');
    await publishStatus(deployment.id, 'FAILED');
    throw new ApiError(503, 'Deployment queue is unavailable; the deployment was marked as FAILED');
  }

  deploymentsCreated.inc({ trigger, target: project.deployment_target });
  logger.info('deployment_queued', {
    deploymentId: deployment.id,
    projectId: project.id,
    jobId: job.id,
    trigger,
    target: project.deployment_target,
    branch,
    commitSha,
  });
  return { deployment, jobId: job.id, duplicate: false };
}

// A manual deployment, requested through the API. The API returns as soon as
// the job is stored in Redis; the worker does the actual processing.
export async function createDeployment(user, projectId, data) {
  const project = await getProject(user, projectId);

  if (project.status !== 'ACTIVE') {
    throw ApiError.conflict('Project is inactive; set its status to ACTIVE before deploying');
  }

  const { deployment, jobId } = await queueDeployment(project, {
    commitSha: data.commit_sha ?? null,
    branch: data.branch ?? project.github_branch,
    trigger: 'MANUAL',
  });
  return { deployment, jobId };
}

// Newest first.
export async function listProjectDeployments(user, projectId) {
  await getProject(user, projectId);

  const { rows } = await query(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments d
     WHERE d.project_id = $1
     ORDER BY d.created_at DESC, d.id`,
    [projectId],
  );
  return rows;
}

// The deployment, if `user` may reach its project: 404 when it does not
// exist, 403 when the project belongs to someone else.
export async function getDeployment(user, deploymentId) {
  const { rows } = await query(
    `SELECT ${DEPLOYMENT_DETAIL_COLUMNS}, p.user_id AS owner_id
     FROM deployments d JOIN projects p ON p.id = d.project_id
     WHERE d.id = $1`,
    [deploymentId],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Deployment not found');
  }
  const { owner_id: ownerId, ...deployment } = rows[0];
  assertAccess(user, ownerId, 'deployment');
  return deployment;
}

// Manual status change through the state machine: only transitions listed
// in deployment_status_transitions are accepted (409 otherwise), and the
// timestamps follow the database rules. The worker drives the status while
// it processes a job; this override is not coordinated with a running job.
// ADMIN only (routes/deployment.routes.js). Returns { before, after }.
export async function updateDeploymentStatus(user, deploymentId, status) {
  const before = await getDeployment(user, deploymentId);
  await transitionDeploymentStatus(deploymentId, status);
  if (before.status !== status) await publishStatus(deploymentId, status);
  return { before, after: await getDeployment(user, deploymentId) };
}
