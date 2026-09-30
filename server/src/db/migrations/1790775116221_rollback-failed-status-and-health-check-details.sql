-- Up Migration

-- ---------------------------------------------------------------------------
-- ROLLBACK_FAILED: a third final status. An unhealthy deployment whose
-- rollback did not bring the last stable deployment back (it could not be
-- restored, or it is unhealthy too) no longer ends as a plain FAILED:
--
--   HEALTH_CHECK -> ROLLING_BACK -> FAILED            the stable version is live again
--                               -> ROLLBACK_FAILED    nothing healthy is live
--
-- FAILED keeps meaning "this deployment failed" with the project in a known
-- state; ROLLBACK_FAILED is the one that needs attention. Deployments that
-- already ended as FAILED with rollback_status = 'FAILED' are history and
-- stay as they are.
-- ---------------------------------------------------------------------------
ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK',
                    'SUCCESS', 'FAILED', 'ROLLBACK_FAILED'));

UPDATE deployment_status_transitions SET description = 'The last stable deployment is live again; this deployment failed'
  WHERE from_status = 'ROLLING_BACK' AND to_status = 'FAILED';

INSERT INTO deployment_status_transitions (from_status, to_status, description) VALUES
  ('ROLLING_BACK', 'ROLLBACK_FAILED', 'The last stable deployment could not be restored, or is unhealthy too');
-- ROLLBACK_FAILED is final: no rows start from it.

-- The one function that changes a deployment's status treats ROLLBACK_FAILED
-- like FAILED: it finishes the deployment and carries the error message.
CREATE OR REPLACE FUNCTION transition_deployment_status(
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
        finished_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED', 'ROLLBACK_FAILED') THEN now() ELSE NULL END,
        error_message = CASE WHEN p_status IN ('FAILED', 'ROLLBACK_FAILED') THEN p_error_message ELSE NULL END
    WHERE id = p_deployment_id
    RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Health-check details of a deployment, kept by the worker while it checks
-- the application, so the API and the dashboard do not have to read them out
-- of log text. One JSON object instead of a column per value:
--   {
--     "status":        "RUNNING" | "PASSED" | "FAILED",
--     "attempts":      3,            attempts made so far
--     "max_attempts":  5,
--     "status_code":   200,          of the last attempt (null: no HTTP answer)
--     "response_time": 38,           of the last attempt, in ms
--     "error":         null,         why the last attempt failed
--     "started_at":    "...",
--     "completed_at":  "..."         null while RUNNING
--   }
-- NULL until the deployment reaches its health check.
-- ---------------------------------------------------------------------------
ALTER TABLE deployments
  ADD COLUMN health_check jsonb CHECK (jsonb_typeof(health_check) = 'object');

-- Down Migration

ALTER TABLE deployments DROP COLUMN health_check;

CREATE OR REPLACE FUNCTION transition_deployment_status(
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

-- ROLLBACK_FAILED cannot be represented any more. Those deployments become
-- FAILED; their rollback_status = 'FAILED' still says what happened. The
-- status is final, so the state-machine trigger is bypassed for this change.
ALTER TABLE deployments DISABLE TRIGGER deployments_enforce_status_transition;
UPDATE deployments SET status = 'FAILED' WHERE status = 'ROLLBACK_FAILED';
ALTER TABLE deployments ENABLE TRIGGER deployments_enforce_status_transition;

DELETE FROM deployment_status_transitions
  WHERE from_status = 'ROLLING_BACK' AND to_status = 'ROLLBACK_FAILED';
UPDATE deployment_status_transitions SET description = 'The rollback ended (restored or not); this deployment failed'
  WHERE from_status = 'ROLLING_BACK' AND to_status = 'FAILED';

ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK', 'SUCCESS', 'FAILED'));
