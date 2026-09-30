import { useEffect, useState } from 'react';
import HealthCheckSummary from './HealthCheckSummary.jsx';
import LogViewer from './LogViewer.jsx';
import RollbackSummary from './RollbackSummary.jsx';
import StatusBadge from './StatusBadge.jsx';
import StatusSteps from './StatusSteps.jsx';
import {
  formatDateTime,
  formatDuration,
  isTerminal,
  repositoryName,
  shortDigest,
  targetLabel,
  taskDefinitionName,
  triggerLabel,
} from '../utils/format.js';

// Re-renders every second while `active`, so running durations tick.
function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// What a deployment that is still running is doing, by status. The line
// under it is always the latest log line the server sent.
const ACTIVITY = {
  QUEUED: 'Waiting for a worker…',
  BUILDING: 'Building the image…',
  DEPLOYING: 'Starting the container…',
  HEALTH_CHECK: 'Running health checks…',
  ROLLING_BACK: 'Health check failed. Restoring the previous stable version…',
};

// The same for deployments to AWS, where they differ.
const AWS_ACTIVITY = {
  BUILDING: 'Building the image and pushing it to Amazon ECR…',
  DEPLOYING: 'Rolling out the new version on Amazon ECS…',
};

function Field({ label, children }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// One deployment: its facts, rollback outcome, error and live logs. `stream`
// comes from useDeploymentStream; its deployment is what the server last
// sent. `numberOf(id)` gives the history number of another deployment;
// `project` is the application it belongs to.
export default function DeploymentDetails({ stream, project, number, numberOf, onSelect, onClose }) {
  const { deployment, logs, connection, ended, error } = stream;
  const now = useNow(deployment && !isTerminal(deployment.status));
  const onAws = deployment?.deployment_target === 'AWS_ECS';
  const activity = deployment && ((onAws && AWS_ACTIVITY[deployment.status]) || ACTIVITY[deployment.status]);

  if (error) {
    return (
      <section className="card details">
        <p className="notice notice--error">Could not load the deployment: {error}</p>
      </section>
    );
  }
  if (!deployment) {
    return (
      <section className="card details">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="card details" aria-labelledby="details-heading">
      <div className="card__header">
        <h2 id="details-heading">Deployment #{number}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <StatusSteps
        status={deployment.status}
        healthCheckFailed={deployment.health_check?.status === 'FAILED' || Boolean(deployment.rollback_status)}
      />

      {activity && (
        <p className={`activity activity--${deployment.status.toLowerCase()}`} role="status">
          <strong>{activity}</strong>
          {logs.length > 0 && <span className="activity__line">{logs.at(-1).message}</span>}
        </p>
      )}

      <dl className="details__grid">
        <Field label="Status">
          <StatusBadge status={deployment.status} />
          {deployment.is_stable && (
            <span className="tag tag--stable" title="The last stable deployment of this application: the live version">
              Stable
            </span>
          )}
        </Field>
        <Field label="Trigger">{triggerLabel(deployment.trigger)}</Field>
        <Field label="Repository">
          {project ? (
            <a href={project.github_repo} target="_blank" rel="noreferrer">
              {repositoryName(project.github_repo)}
            </a>
          ) : (
            '—'
          )}
        </Field>
        <Field label="Branch">
          <span className="mono">{deployment.branch}</span>
        </Field>
        <Field label="Commit">
          {deployment.commit_sha && project ? (
            <a
              className="mono"
              href={`${project.github_repo}/commit/${deployment.commit_sha}`}
              target="_blank"
              rel="noreferrer"
            >
              {deployment.commit_sha}
            </a>
          ) : (
            <span className="mono">{deployment.commit_sha ?? 'branch head (resolved when built)'}</span>
          )}
        </Field>
        <Field label="Target">{targetLabel(deployment.deployment_target)}</Field>
        <Field label="Created">{formatDateTime(deployment.created_at)}</Field>
        <Field label="Started">{formatDateTime(deployment.started_at)}</Field>
        <Field label="Finished">{formatDateTime(deployment.finished_at)}</Field>
        <Field label="Duration">{formatDuration(deployment.started_at, deployment.finished_at, now)}</Field>
        <Field label="Image version">
          <span className="mono">{deployment.docker_image ?? '—'}</span>
        </Field>
        {deployment.image_digest && (
          <Field label="Image digest">
            <span className="mono" title={deployment.image_digest}>
              {shortDigest(deployment.image_digest)}
            </span>
          </Field>
        )}
        {onAws ? (
          <Field label="ECS task definition">
            <span className="mono" title={deployment.aws_task_definition_arn ?? undefined}>
              {taskDefinitionName(deployment.aws_task_definition_arn)}
            </span>
          </Field>
        ) : (
          <Field label="Container">
            <span className="mono">
              {deployment.container_name
                ? `${deployment.container_name}${deployment.container_removed_at ? ' (removed)' : ''}`
                : '—'}
            </span>
          </Field>
        )}
        {onAws && deployment.is_stable && project?.aws_service_url && (
          <Field label="Service URL">
            <a href={project.aws_service_url} target="_blank" rel="noreferrer">
              {project.aws_service_url}
            </a>
          </Field>
        )}
        {deployment.host_port && !deployment.container_removed_at && (
          <Field label="Local URL">
            <a href={`http://127.0.0.1:${deployment.host_port}/`} target="_blank" rel="noreferrer">
              http://127.0.0.1:{deployment.host_port}/
            </a>
          </Field>
        )}
        <Field label="ID">
          <span className="mono">{deployment.id}</span>
        </Field>
      </dl>

      <HealthCheckSummary check={deployment.health_check} />
      <RollbackSummary deployment={deployment} numberOf={numberOf} onSelect={onSelect} />

      {(deployment.status === 'FAILED' || deployment.status === 'ROLLBACK_FAILED') && (
        <div className="notice notice--error" role="alert">
          <strong>Error</strong>
          <div>{deployment.error_message ?? 'The deployment failed (see the logs).'}</div>
        </div>
      )}

      <LogViewer
        logs={logs}
        connection={connection}
        status={deployment.status}
        rollbackStatus={deployment.rollback_status}
        ended={ended}
      />
    </section>
  );
}
