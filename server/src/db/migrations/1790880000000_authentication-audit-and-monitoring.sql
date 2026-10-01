-- Up Migration

-- Phase 8: authentication, roles, sessions, audit log, and the indexes the
-- monitoring and recovery queries need.

-- ---------------------------------------------------------------------------
-- users: a password and a role.
--
-- password_hash is a self-describing scrypt hash
--   scrypt$<log2 N>$<r>$<p>$<salt, base64url>$<hash, base64url>
-- (server/src/services/password.js). It is NULL for accounts that cannot
-- sign in, such as the Phase 2-7 development user, until a password is set
-- with `npm --prefix server run user:create`.
--
-- role: ADMIN sees and manages every project and may use the operator
-- endpoints; USER only reaches its own projects.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN password_hash  varchar(255) CHECK (password_hash ~ '^scrypt\$[0-9]{1,2}\$[0-9]{1,2}\$[0-9]{1,2}\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$'),
  ADD COLUMN role           varchar(10) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
  ADD COLUMN last_login_at  timestamptz;

-- ---------------------------------------------------------------------------
-- sessions: server-side sign-in sessions.
--
-- The browser holds a random 256-bit token in an HttpOnly cookie; only its
-- SHA-256 is stored, so a copy of this table cannot be used to sign in.
-- A session ends at expires_at (absolute lifetime), after a period without
-- requests (last_seen_at, idle timeout), on sign-out, or with its user.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  ip            varchar(45),
  user_agent    varchar(255),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
-- Serves the removal of expired sessions.
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- audit_logs: who did what, for security-sensitive actions (sign-in, project
-- and deployment changes, webhook deliveries). Append-only; entries outlive
-- the user they name (user_id becomes NULL). `details` never holds
-- credentials: passwords, tokens and secrets are not passed to it.
-- What happens inside a deployment (build, health check, rollback) is already
-- recorded in deployments and deployment_logs and is not duplicated here.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  action       varchar(64) NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type  varchar(32) CHECK (target_type IN ('user', 'project', 'deployment', 'repository')),
  target_id    varchar(255),
  ip           varchar(45),
  request_id   varchar(64),
  details      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Newest first, overall and per user.
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC, id DESC);
CREATE INDEX audit_logs_user_id_created_at_idx ON audit_logs (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Monitoring and recovery queries.
--
-- Unfinished deployments are a handful of rows among the whole history, and
-- both the stuck-deployment check (every minute, by updated_at) and the
-- dashboard's monitoring overview (every few seconds) look only at them.
-- The overview's 24-hour outcome counts read finished deployments by
-- finished_at.
-- ---------------------------------------------------------------------------
CREATE INDEX deployments_unfinished_idx ON deployments (updated_at)
  WHERE status IN ('QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK');
CREATE INDEX deployments_finished_at_idx ON deployments (finished_at)
  WHERE finished_at IS NOT NULL;

-- Down Migration

DROP INDEX deployments_finished_at_idx;
DROP INDEX deployments_unfinished_idx;
DROP TABLE audit_logs;
DROP TABLE sessions;
ALTER TABLE users
  DROP COLUMN last_login_at,
  DROP COLUMN role,
  DROP COLUMN password_hash;
