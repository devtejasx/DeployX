-- Up Migration

-- Phase 7: GitHub push deployments and AWS (ECR + ECS/Fargate) targets.
--
-- The repository itself needs no new columns: github_repo is the canonical
-- https://github.com/<owner>/<repo> (owner and name are read from it) and
-- github_branch is the branch that is deployed.

-- ---------------------------------------------------------------------------
-- Where a project's deployments run:
--   LOCAL     a container on the worker's Docker host (Phases 4-6)
--   AWS_ECS   an Amazon ECS service (Fargate or EC2), image pushed to ECR
-- An AWS_ECS project names its ECS service (in the cluster the worker is
-- configured with, AWS_ECS_CLUSTER) and the base URL the service answers on,
-- where the Phase 6 health check requests health_check_path. Only names and a
-- URL are stored: AWS credentials never are, they come from the worker's
-- environment or IAM role.
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN deployment_target varchar(20) NOT NULL DEFAULT 'LOCAL'
    CONSTRAINT projects_deployment_target_check CHECK (deployment_target IN ('LOCAL', 'AWS_ECS')),
  -- ECS service names: letters, digits, hyphens and underscores.
  ADD COLUMN aws_ecs_service varchar(255)
    CONSTRAINT projects_aws_ecs_service_check CHECK (aws_ecs_service ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'),
  -- An origin only (scheme, lower-case host, optional port): no credentials,
  -- path or query. The same rule is applied by the API and the worker.
  ADD COLUMN aws_service_url varchar(255)
    CONSTRAINT projects_aws_service_url_check
    CHECK (aws_service_url ~ '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'),
  ADD CONSTRAINT projects_aws_ecs_config_check
    CHECK (deployment_target <> 'AWS_ECS' OR (aws_ecs_service IS NOT NULL AND aws_service_url IS NOT NULL));

-- One ECS service is one live slot: two projects deploying to it would replace
-- each other's version. (The cluster is the same for every project.)
CREATE UNIQUE INDEX projects_aws_ecs_service_key ON projects (aws_ecs_service)
  WHERE deployment_target = 'AWS_ECS';

-- Serves the webhook's "projects of this repository" lookup. GitHub owner and
-- repository names are case-insensitive.
CREATE INDEX projects_github_repo_lower_idx ON projects (lower(github_repo));

-- ---------------------------------------------------------------------------
-- deployments
-- ---------------------------------------------------------------------------
ALTER TABLE deployments
  -- What created the deployment: the API (dashboard, curl) or a GitHub push
  -- webhook. Both go through the same queue, worker and pipeline.
  ADD COLUMN trigger varchar(20) NOT NULL DEFAULT 'MANUAL'
    CONSTRAINT deployments_trigger_check CHECK (trigger IN ('MANUAL', 'GITHUB_PUSH')),
  -- The project's target when the deployment was created. The worker deploys
  -- (and rolls back) on this target even if the project is changed meanwhile.
  ADD COLUMN deployment_target varchar(20) NOT NULL DEFAULT 'LOCAL'
    CONSTRAINT deployments_deployment_target_check CHECK (deployment_target IN ('LOCAL', 'AWS_ECS')),
  -- Manifest digest of the image in the registry (AWS_ECS): the immutable
  -- version ECS runs (<repository>@<digest>) and a rollback restores.
  -- docker_image stays the human-readable tag, docker_image_id the local ID.
  ADD COLUMN image_digest varchar(71)
    CONSTRAINT deployments_image_digest_check CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- The ECS task definition revision the deployment runs as (AWS_ECS), the
  -- counterpart of container_id for LOCAL.
  ADD COLUMN aws_task_definition_arn varchar(1024)
    CONSTRAINT deployments_aws_task_definition_arn_check
    CHECK (aws_task_definition_arn ~ '^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]{1,255}:[0-9]+$'),
  -- A push deployment is always pinned to the full commit SHA GitHub sent, so
  -- it never deploys a moving branch head and duplicates can be recognised.
  ADD CONSTRAINT deployments_github_push_commit_check
    CHECK (trigger <> 'GITHUB_PUSH' OR (commit_sha IS NOT NULL AND char_length(commit_sha) = 40));

-- Duplicate protection for webhooks: GitHub redelivers events, and one commit
-- is deployed once per project by push. Manual deployments of any commit stay
-- possible (e.g. to redeploy it).
CREATE UNIQUE INDEX deployments_github_push_commit_key ON deployments (project_id, commit_sha)
  WHERE trigger = 'GITHUB_PUSH';

-- Down Migration

DROP INDEX deployments_github_push_commit_key;

ALTER TABLE deployments
  DROP CONSTRAINT deployments_github_push_commit_check,
  DROP COLUMN aws_task_definition_arn,
  DROP COLUMN image_digest,
  DROP COLUMN deployment_target,
  DROP COLUMN trigger;

DROP INDEX projects_github_repo_lower_idx;
DROP INDEX projects_aws_ecs_service_key;

ALTER TABLE projects
  DROP CONSTRAINT projects_aws_ecs_config_check,
  DROP COLUMN aws_service_url,
  DROP COLUMN aws_ecs_service,
  DROP COLUMN deployment_target;
