-- Up Migration

-- Port the deployed application listens on inside its container. DeployX
-- never guesses it: the API requires it for new projects. It stays nullable
-- only for projects created before this migration; deploying such a project
-- fails with a clear message until the port is set.
ALTER TABLE projects
  ADD COLUMN container_port integer CHECK (container_port BETWEEN 1 AND 65535);

-- What the worker created for a deployment.
ALTER TABLE deployments
  -- Full Docker container ID.
  ADD COLUMN container_id varchar(64) CHECK (container_id ~ '^[0-9a-f]{12,64}$'),
  -- deployx-<project-id>-<deployment-id>
  ADD COLUMN container_name varchar(255),
  -- Host port Docker published the container port on (bound to 127.0.0.1).
  ADD COLUMN host_port integer CHECK (host_port BETWEEN 1 AND 65535),
  -- Set when the container is removed, e.g. replaced by a newer deployment.
  -- The deployment row itself is kept as history.
  ADD COLUMN container_removed_at timestamptz,
  -- Short reason for a FAILED deployment (details are in deployment_logs).
  ADD COLUMN error_message varchar(2000);

-- Down Migration

ALTER TABLE deployments
  DROP COLUMN error_message,
  DROP COLUMN container_removed_at,
  DROP COLUMN host_port,
  DROP COLUMN container_name,
  DROP COLUMN container_id;

ALTER TABLE projects
  DROP COLUMN container_port;
