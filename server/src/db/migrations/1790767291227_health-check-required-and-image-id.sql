-- Up Migration

-- A running container is no longer enough: a deployment can only become
-- SUCCESS after its health check, i.e. from HEALTH_CHECK. Removing this one
-- transition makes that a database rule for the worker, the API and plain SQL.
DELETE FROM deployment_status_transitions
  WHERE from_status = 'DEPLOYING' AND to_status = 'SUCCESS';

-- The immutable ID of the image a deployment was built as. docker_image is a
-- tag (<repository>:<commit>), and a later build of the same commit moves
-- that tag to another image; a rollback must start exactly the image the
-- stable deployment ran, so it uses this ID. (The worker also gives every
-- image a <repository>:deployment-<id> tag, which keeps it on the Docker
-- host.) NULL for deployments built before this migration: a rollback then
-- falls back to the tag.
ALTER TABLE deployments
  ADD COLUMN docker_image_id varchar(80) CHECK (docker_image_id ~ '^sha256:[0-9a-f]{64}$');

-- Down Migration

ALTER TABLE deployments DROP COLUMN docker_image_id;

INSERT INTO deployment_status_transitions (from_status, to_status, description) VALUES
  ('DEPLOYING', 'SUCCESS', 'The container is running');
