-- Up Migration

-- Phase 6: health checks, stable deployments and automatic rollback.

-- ---------------------------------------------------------------------------
-- Health-check path of a project: the worker requests it on the deployed
-- container (GET, on the project's container_port) and only a 2xx answer
-- counts as healthy. An absolute path with an optional query string; it can
-- never name another host. The same rule is applied by the API and the worker.
-- ---------------------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN health_check_path varchar(255) NOT NULL DEFAULT '/health'
    CONSTRAINT projects_health_check_path_check
    CHECK (health_check_path ~ '^/([A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*/?)?(\?[A-Za-z0-9._~=&-]*)?$');

-- ---------------------------------------------------------------------------
-- ROLLING_BACK: an unhealthy deployment while its project's last stable
-- deployment is being restored. HEALTH_CHECK already exists.
-- ---------------------------------------------------------------------------
ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK', 'SUCCESS', 'FAILED'));

-- Outcome of the automatic rollback of a deployment that failed its health
-- check (NULL for every other deployment):
--   COMPLETED      the last stable deployment is live again and healthy
--   FAILED         it could not be restored, or it is unhealthy too
--   NOT_AVAILABLE  the project had no stable deployment to roll back to
ALTER TABLE deployments
  ADD COLUMN rollback_status varchar(20)
    CHECK (rollback_status IN ('COMPLETED', 'FAILED', 'NOT_AVAILABLE')),
  -- The stable deployment the rollback restored (or tried to restore).
  ADD COLUMN rollback_deployment_id uuid REFERENCES deployments (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- State machine: FAILED and SUCCESS stay final. A deployment that fails its
-- health check is rolled back BEFORE it becomes FAILED:
--   HEALTH_CHECK -> ROLLING_BACK -> FAILED
-- so everything that follows its status (e.g. the live log stream, which
-- ends on a final status) sees the whole rollback.
-- ---------------------------------------------------------------------------
UPDATE deployment_status_transitions SET description = 'The container is running; checking the application''s health'
  WHERE from_status = 'DEPLOYING' AND to_status = 'HEALTH_CHECK';
UPDATE deployment_status_transitions SET description = 'The application answered its health check'
  WHERE from_status = 'HEALTH_CHECK' AND to_status = 'SUCCESS';
UPDATE deployment_status_transitions SET description = 'The application is unhealthy and there is no stable deployment to roll back to'
  WHERE from_status = 'HEALTH_CHECK' AND to_status = 'FAILED';
UPDATE deployment_status_transitions SET description = 'The attempt failed; BullMQ will retry the job'
  WHERE from_status = 'HEALTH_CHECK' AND to_status = 'QUEUED';

INSERT INTO deployment_status_transitions (from_status, to_status, description) VALUES
  ('HEALTH_CHECK', 'ROLLING_BACK', 'The application is unhealthy; restoring the last stable deployment'),
  ('ROLLING_BACK', 'FAILED',       'The rollback ended (restored or not); this deployment failed');

-- ---------------------------------------------------------------------------
-- Stable deployments are derived, not stored: a deployment is stable when it
-- is SUCCESS, and the last stable deployment of a project is its most
-- recently finished SUCCESS deployment. A deployment that failed or was
-- rolled back is FAILED, so it is never stable; nothing has to be flagged or
-- un-flagged, and history rows are never touched.
-- The API and the worker both use this one definition.
-- ---------------------------------------------------------------------------
CREATE INDEX deployments_stable_idx
  ON deployments (project_id, finished_at DESC NULLS LAST)
  WHERE status = 'SUCCESS';

CREATE FUNCTION stable_deployment_id(p_project_id uuid) RETURNS uuid AS $$
  SELECT id FROM deployments
  WHERE project_id = p_project_id AND status = 'SUCCESS'
  ORDER BY finished_at DESC NULLS LAST, created_at DESC, id
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Down Migration

DROP FUNCTION stable_deployment_id(uuid);
DROP INDEX deployments_stable_idx;

-- A rollback in progress cannot be represented any more: end it as FAILED.
SELECT transition_deployment_status(id, 'FAILED', 'Rollback interrupted by a schema downgrade')
  FROM deployments WHERE status = 'ROLLING_BACK';

DELETE FROM deployment_status_transitions
  WHERE (from_status, to_status) IN (('HEALTH_CHECK', 'ROLLING_BACK'), ('ROLLING_BACK', 'FAILED'));

UPDATE deployment_status_transitions SET description = 'Reserved for Phase 6: container started, checking health'
  WHERE from_status = 'DEPLOYING' AND to_status = 'HEALTH_CHECK';
UPDATE deployment_status_transitions SET description = 'Reserved for Phase 6: the application is healthy'
  WHERE from_status = 'HEALTH_CHECK' AND to_status = 'SUCCESS';
UPDATE deployment_status_transitions SET description = 'Reserved for Phase 6: the application is unhealthy'
  WHERE from_status = 'HEALTH_CHECK' AND to_status = 'FAILED';
UPDATE deployment_status_transitions SET description = 'Reserved for Phase 6: the attempt failed; BullMQ will retry the job'
  WHERE from_status = 'HEALTH_CHECK' AND to_status = 'QUEUED';

ALTER TABLE deployments
  DROP COLUMN rollback_deployment_id,
  DROP COLUMN rollback_status;

ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS', 'FAILED'));

ALTER TABLE projects DROP COLUMN health_check_path;
