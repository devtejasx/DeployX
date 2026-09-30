import { query } from '../db/postgres.js';
import { ApiError } from '../utils/ApiError.js';
import { AWS_ECS_CONFIG_ERROR } from '../validators/project.validators.js';

const PROJECT_COLUMNS = `id, user_id, name, description, github_repo, github_branch,
  dockerfile_path, container_port, health_check_path, deployment_target, aws_ecs_service, aws_service_url,
  status, created_at, updated_at`;

// Columns a client may change. Keys of the validated body are mapped through
// this list, so column names in the UPDATE never come from user input.
const UPDATABLE_COLUMNS = [
  'name',
  'description',
  'github_repo',
  'github_branch',
  'dockerfile_path',
  'container_port',
  'health_check_path',
  'deployment_target',
  'aws_ecs_service',
  'aws_service_url',
  'status',
];

// Turns the constraint violations a valid request can still cause into
// readable errors: a duplicate name, an ECS service another project already
// deploys to, or an AWS_ECS project left without its service or URL.
function rethrowConflict(err, data) {
  if (err.code === '23505' && err.constraint === 'projects_user_id_name_key') {
    throw ApiError.conflict(`A project named "${data.name}" already exists`);
  }
  if (err.code === '23505' && err.constraint === 'projects_aws_ecs_service_key') {
    const service = data.aws_ecs_service ? `ECS service "${data.aws_ecs_service}"` : "The project's ECS service";
    throw ApiError.conflict(`${service} is already used by another project`);
  }
  if (err.code === '23514' && err.constraint === 'projects_aws_ecs_config_check') {
    throw ApiError.badRequest('Validation failed', [AWS_ECS_CONFIG_ERROR]);
  }
  throw err;
}

export async function listProjects(userId) {
  const { rows } = await query(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE user_id = $1 ORDER BY created_at DESC, id`,
    [userId],
  );
  return rows;
}

export async function getProject(userId, projectId) {
  const { rows } = await query(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
    [projectId, userId],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Project not found');
  }
  return rows[0];
}

export async function createProject(userId, data) {
  try {
    const { rows } = await query(
      `INSERT INTO projects
         (user_id, name, description, github_repo, github_branch, dockerfile_path, container_port,
          health_check_path, deployment_target, aws_ecs_service, aws_service_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${PROJECT_COLUMNS}`,
      [
        userId,
        data.name,
        data.description ?? null,
        data.github_repo,
        data.github_branch,
        data.dockerfile_path,
        data.container_port,
        data.health_check_path,
        data.deployment_target,
        data.aws_ecs_service,
        data.aws_service_url,
        data.status,
      ],
    );
    return rows[0];
  } catch (err) {
    rethrowConflict(err, data);
  }
}

export async function updateProject(userId, projectId, changes) {
  const columns = UPDATABLE_COLUMNS.filter((column) => column in changes);
  const assignments = columns.map((column, index) => `${column} = $${index + 3}`);
  const values = columns.map((column) => changes[column]);

  try {
    const { rows } = await query(
      `UPDATE projects SET ${assignments.join(', ')}
       WHERE id = $1 AND user_id = $2
       RETURNING ${PROJECT_COLUMNS}`,
      [projectId, userId, ...values],
    );
    if (rows.length === 0) {
      throw ApiError.notFound('Project not found');
    }
    return rows[0];
  } catch (err) {
    rethrowConflict(err, changes);
  }
}

// ACTIVE and INACTIVE projects of any user whose repository is `repoUrl`
// (canonical https://github.com/<owner>/<repo>, compared case-insensitively
// like GitHub does). Used by the GitHub webhook, which acts for the
// repository, not for a signed-in user.
export async function findProjectsByRepository(repoUrl) {
  const { rows } = await query(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE lower(github_repo) = lower($1) ORDER BY created_at, id`,
    [repoUrl],
  );
  return rows;
}

// Deployments and their logs are removed by ON DELETE CASCADE in the same
// statement, so no orphan rows can remain.
export async function deleteProject(userId, projectId) {
  const { rows } = await query(
    `DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING ${PROJECT_COLUMNS}`,
    [projectId, userId],
  );
  if (rows.length === 0) {
    throw ApiError.notFound('Project not found');
  }
  return rows[0];
}
