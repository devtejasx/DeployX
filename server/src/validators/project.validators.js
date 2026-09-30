import { z } from 'zod';
import { branchField, enumField, stringField } from './common.js';

export const PROJECT_STATUSES = ['ACTIVE', 'INACTIVE'];

// https://github.com/<owner>/<repo>, optionally ending in .git or /.
const GITHUB_REPO_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

// Relative path inside the repository: no leading "/", no ".." segments.
const DOCKERFILE_PATH_PATTERN = /^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._/-]+(?<!\/)$/;

const name = stringField('Project name')
  .trim()
  .min(1, { error: 'Project name is required' })
  .max(100, { error: 'Project name must be at most 100 characters' });

// Optional free text; an empty string clears it.
const description = stringField('Description')
  .trim()
  .max(1000, { error: 'Description must be at most 1000 characters' })
  .nullable()
  .transform((value) => (value ? value : null));

// Stored in canonical form: https://github.com/<owner>/<repo>
const githubRepo = stringField('GitHub repository URL')
  .trim()
  .min(1, { error: 'GitHub repository URL is required' })
  .regex(GITHUB_REPO_PATTERN, {
    error: 'GitHub repository URL must look like https://github.com/<owner>/<repo>',
  })
  .refine((url) => !/\/(\.|\.\.)(\.git)?\/?$/.test(url), {
    error: 'GitHub repository URL must look like https://github.com/<owner>/<repo>',
  })
  .transform((url) => {
    const [, owner, repo] = url.match(GITHUB_REPO_PATTERN);
    return `https://github.com/${owner}/${repo}`;
  });

const dockerfilePath = stringField('Dockerfile path')
  .trim()
  .min(1, { error: 'Dockerfile path is required' })
  .max(255, { error: 'Dockerfile path must be at most 255 characters' })
  .regex(DOCKERFILE_PATH_PATTERN, {
    error: 'Dockerfile path must be a relative path inside the repository (no leading "/" or "..")',
  });

const status = enumField('Project status', PROJECT_STATUSES);

// Path the worker requests on the deployed container to check its health.
// An absolute path with an optional query string ("/health", "/api/status",
// "/health?probe=1"): it can never name a scheme or another host. The same
// rule is enforced by the database and re-checked by the worker.
const HEALTH_CHECK_PATH_PATTERN =
  /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?(?:\?[A-Za-z0-9._~=&-]*)?$/;

const healthCheckPath = stringField('Health check path')
  .trim()
  .min(1, { error: 'Health check path is required' })
  .max(255, { error: 'Health check path must be at most 255 characters' })
  .regex(HEALTH_CHECK_PATH_PATTERN, {
    error: 'Health check path must be an absolute path such as /health (no host, spaces or "//")',
  });

// Port the application listens on inside its container. Required: DeployX
// never guesses it.
const containerPort = z
  .number({
    error: (issue) =>
      issue.input === undefined ? 'Container port is required' : 'Container port must be a number',
  })
  .int({ error: 'Container port must be an integer between 1 and 65535' })
  .min(1, { error: 'Container port must be an integer between 1 and 65535' })
  .max(65535, { error: 'Container port must be an integer between 1 and 65535' });

// id, user_id, created_at and updated_at are not accepted: strict objects
// reject any field not listed here.
export const createProjectSchema = z.strictObject({
  name,
  description: description.optional(),
  github_repo: githubRepo,
  github_branch: branchField('GitHub branch').default('main'),
  dockerfile_path: dockerfilePath.default('Dockerfile'),
  container_port: containerPort,
  health_check_path: healthCheckPath.default('/health'),
  status: status.default('ACTIVE'),
});

// PUT accepts any subset of the editable fields; omitted fields are unchanged.
export const updateProjectSchema = z
  .strictObject({
    name: name.optional(),
    description: description.optional(),
    github_repo: githubRepo.optional(),
    github_branch: branchField('GitHub branch').optional(),
    dockerfile_path: dockerfilePath.optional(),
    container_port: containerPort.optional(),
    health_check_path: healthCheckPath.optional(),
    status: status.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'Provide at least one field to update',
  });
