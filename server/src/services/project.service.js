import { query } from '../db/postgres.js';
import { ApiError } from '../utils/ApiError.js';

const PROJECT_COLUMNS = `id, user_id, name, description, github_repo, github_branch,
  dockerfile_path, container_port, status, created_at, updated_at`;

// Columns a client may change. Keys of the validated body are mapped through
// this list, so column names in the UPDATE never come from user input.
const UPDATABLE_COLUMNS = [
  'name',
  'description',
  'github_repo',
  'github_branch',
  'dockerfile_path',
  'container_port',
  'status',
];

function rethrowDuplicateName(err, name) {
  if (err.code === '23505' && err.constraint === 'projects_user_id_name_key') {
    throw ApiError.conflict(`A project named "${name}" already exists`);
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
         (user_id, name, description, github_repo, github_branch, dockerfile_path, container_port, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PROJECT_COLUMNS}`,
      [
        userId,
        data.name,
        data.description ?? null,
        data.github_repo,
        data.github_branch,
        data.dockerfile_path,
        data.container_port,
        data.status,
      ],
    );
    return rows[0];
  } catch (err) {
    rethrowDuplicateName(err, data.name);
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
    rethrowDuplicateName(err, changes.name);
  }
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
