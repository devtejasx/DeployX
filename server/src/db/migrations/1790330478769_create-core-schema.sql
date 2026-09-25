-- Up Migration

-- Keeps updated_at current on every UPDATE, whatever code path changes the row.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  -- Stored lower-case so the unique constraint is effectively case-insensitive.
  email       varchar(255) NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- projects: belong to a user; removed together with their user.
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name             varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  description      varchar(1000),
  github_repo      varchar(255) NOT NULL,
  github_branch    varchar(255) NOT NULL DEFAULT 'main',
  dockerfile_path  varchar(255) NOT NULL DEFAULT 'Dockerfile',
  status           varchar(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A user cannot have two projects with the same name. The underlying index
  -- (user_id, name) also serves every "projects of this user" lookup.
  CONSTRAINT projects_user_id_name_key UNIQUE (user_id, name)
);

CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- deployments: belong to a project; removed together with their project.
-- ---------------------------------------------------------------------------
CREATE TABLE deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  commit_sha    varchar(40) CHECK (commit_sha ~ '^[0-9a-f]{7,40}$'),
  branch        varchar(255) NOT NULL,
  status        varchar(20) NOT NULL DEFAULT 'QUEUED'
                CHECK (status IN ('QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS', 'FAILED')),
  docker_image  varchar(255),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Serves "deployments of a project, newest first".
CREATE INDEX deployments_project_id_created_at_idx ON deployments (project_id, created_at DESC);

CREATE TRIGGER deployments_set_updated_at
  BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- deployment_logs: append-only; removed together with their deployment.
-- A bigint identity keeps insertion order stable even within one timestamp.
-- ---------------------------------------------------------------------------
CREATE TABLE deployment_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment_id  uuid NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  level          varchar(10) NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR')),
  message        text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 10000),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Serves "logs of a deployment in chronological order".
CREATE INDEX deployment_logs_deployment_id_id_idx ON deployment_logs (deployment_id, id);

-- Down Migration

DROP TABLE deployment_logs;
DROP TABLE deployments;
DROP TABLE projects;
DROP TABLE users;
DROP FUNCTION set_updated_at();
