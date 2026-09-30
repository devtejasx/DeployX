import { z } from 'zod';
import { parseGitHubRepo } from '../utils/github.js';
import { branchField, enumField, stringField } from './common.js';

export const PROJECT_STATUSES = ['ACTIVE', 'INACTIVE'];
// LOCAL: a container on the worker's Docker host. AWS_ECS: an ECS service.
export const DEPLOYMENT_TARGETS = ['LOCAL', 'AWS_ECS'];

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
  .refine((url) => parseGitHubRepo(url) !== null, {
    error: 'GitHub repository URL must look like https://github.com/<owner>/<repo>',
  })
  .transform((url) => parseGitHubRepo(url).url);

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

const deploymentTarget = enumField('Deployment target', DEPLOYMENT_TARGETS);

export const AWS_ECS_CONFIG_ERROR = 'An AWS_ECS project needs aws_ecs_service and aws_service_url';

// Name of the project's ECS service in the worker's cluster (AWS_ECS only).
const awsEcsService = stringField('AWS ECS service')
  .trim()
  .min(1, { error: 'AWS ECS service is required' })
  .max(255, { error: 'AWS ECS service must be at most 255 characters' })
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    error: 'AWS ECS service must contain only letters, digits, hyphens and underscores',
  })
  .nullable();

// Base URL the ECS service answers on (e.g. its load balancer), where the
// worker requests health_check_path. Stored as an origin: scheme, lower-case
// host and optional port - no credentials, path, query or fragment. The same
// rule is enforced by the database and re-checked by the worker, which also
// refuses hosts that resolve to link-local or (unless allowed) private addresses.
const SERVICE_URL_ERROR = 'AWS service URL must be an http(s) origin such as https://my-app.example.com';

function serviceOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const originOnly =
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !value.includes('?') &&
    !value.includes('#') &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(url.hostname);
  return originOnly ? url.origin : null;
}

const awsServiceUrl = stringField('AWS service URL')
  .trim()
  .min(1, { error: 'AWS service URL is required' })
  .max(255, { error: 'AWS service URL must be at most 255 characters' })
  .refine((value) => serviceOrigin(value) !== null, { error: SERVICE_URL_ERROR })
  .transform((value) => serviceOrigin(value))
  .nullable();

// id, user_id, created_at and updated_at are not accepted: strict objects
// reject any field not listed here.
export const createProjectSchema = z
  .strictObject({
    name,
    description: description.optional(),
    github_repo: githubRepo,
    github_branch: branchField('GitHub branch').default('main'),
    dockerfile_path: dockerfilePath.default('Dockerfile'),
    container_port: containerPort,
    health_check_path: healthCheckPath.default('/health'),
    deployment_target: deploymentTarget.default('LOCAL'),
    aws_ecs_service: awsEcsService.default(null),
    aws_service_url: awsServiceUrl.default(null),
    status: status.default('ACTIVE'),
  })
  .refine((body) => body.deployment_target !== 'AWS_ECS' || (body.aws_ecs_service && body.aws_service_url), {
    error: AWS_ECS_CONFIG_ERROR,
  });

// PUT accepts any subset of the editable fields; omitted fields are unchanged.
// (Whether an AWS_ECS project ends up with its service and URL is checked
// against the stored project, see project.service.js.)
export const updateProjectSchema = z
  .strictObject({
    name: name.optional(),
    description: description.optional(),
    github_repo: githubRepo.optional(),
    github_branch: branchField('GitHub branch').optional(),
    dockerfile_path: dockerfilePath.optional(),
    container_port: containerPort.optional(),
    health_check_path: healthCheckPath.optional(),
    deployment_target: deploymentTarget.optional(),
    aws_ecs_service: awsEcsService.optional(),
    aws_service_url: awsServiceUrl.optional(),
    status: status.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'Provide at least one field to update',
  });
