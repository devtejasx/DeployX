-- Up Migration

-- Deployment state machine.
--
-- The allowed status transitions live here, in one table, and are enforced
-- by a trigger for EVERY update of deployments.status - from the API, the
-- worker or plain SQL. Both services change status only through
-- transition_deployment_status(), which also keeps the timestamps right.
-- Extending the machine (e.g. rollback in Phase 6) is a migration that
-- inserts rows here.
CREATE TABLE deployment_status_transitions (
  from_status  varchar(20) NOT NULL,
  to_status    varchar(20) NOT NULL,
  description  varchar(200) NOT NULL,
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status <> to_status)
);

INSERT INTO deployment_status_transitions (from_status, to_status, description) VALUES
  ('QUEUED',       'BUILDING',     'The worker started the job'),
  ('QUEUED',       'FAILED',       'The job could not be queued, or failed before building'),
  ('BUILDING',     'DEPLOYING',    'The image was built'),
  ('BUILDING',     'FAILED',       'Clone, checkout, Dockerfile check or build failed for good'),
  ('BUILDING',     'QUEUED',       'The attempt failed; BullMQ will retry the job'),
  ('DEPLOYING',    'SUCCESS',      'The container is running'),
  ('DEPLOYING',    'FAILED',       'The container failed to start for good'),
  ('DEPLOYING',    'QUEUED',       'The attempt failed; BullMQ will retry the job'),
  -- HEALTH_CHECK is reserved for Phase 6 (health checks); nothing enters it yet.
  ('DEPLOYING',    'HEALTH_CHECK', 'Reserved for Phase 6: container started, checking health'),
  ('HEALTH_CHECK', 'SUCCESS',      'Reserved for Phase 6: the application is healthy'),
  ('HEALTH_CHECK', 'FAILED',       'Reserved for Phase 6: the application is unhealthy'),
  ('HEALTH_CHECK', 'QUEUED',       'Reserved for Phase 6: the attempt failed; BullMQ will retry the job');
-- SUCCESS and FAILED are final: no rows start from them.

-- Rejects any status change that is not listed above. SQLSTATE DX001 and a
-- JSON detail {"from": ..., "to": ...} let callers report it precisely.
CREATE FUNCTION enforce_deployment_status_transition() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM deployment_status_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Invalid deployment state transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'DX001',
            DETAIL = json_build_object('from', OLD.status, 'to', NEW.status)::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deployments_enforce_status_transition
  BEFORE UPDATE OF status ON deployments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_deployment_status_transition();

-- The one way to change a deployment's status:
--   1. locks the deployment row and reads its current status
--   2. returns nothing if the deployment does not exist
--   3. returns the row unchanged if it already has that status (idempotent,
--      so a retry of the same step is harmless)
--   4. otherwise updates it; the trigger rejects invalid transitions
-- Timestamps:
--   started_at    set when work first begins (kept across retries)
--   finished_at   set on SUCCESS/FAILED, cleared otherwise
--   error_message set on FAILED (from p_error_message), cleared otherwise
CREATE FUNCTION transition_deployment_status(
  p_deployment_id uuid,
  p_status varchar,
  p_error_message varchar DEFAULT NULL
) RETURNS SETOF deployments AS $$
DECLARE
  current_status varchar;
BEGIN
  SELECT status INTO current_status FROM deployments WHERE id = p_deployment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF current_status = p_status THEN
    RETURN QUERY SELECT * FROM deployments WHERE id = p_deployment_id;
    RETURN;
  END IF;

  RETURN QUERY
    UPDATE deployments
    SET status = p_status,
        started_at = CASE
          WHEN p_status IN ('BUILDING', 'DEPLOYING', 'HEALTH_CHECK') THEN COALESCE(started_at, now())
          ELSE started_at
        END,
        finished_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED') THEN now() ELSE NULL END,
        error_message = CASE WHEN p_status = 'FAILED' THEN p_error_message ELSE NULL END
    WHERE id = p_deployment_id
    RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Down Migration

DROP FUNCTION transition_deployment_status(uuid, varchar, varchar);
DROP TRIGGER deployments_enforce_status_transition ON deployments;
DROP FUNCTION enforce_deployment_status_transition();
DROP TABLE deployment_status_transitions;
