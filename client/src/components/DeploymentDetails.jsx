import { useEffect, useState } from 'react';
import LogViewer from './LogViewer.jsx';
import StatusBadge from './StatusBadge.jsx';
import StatusSteps from './StatusSteps.jsx';
import { formatDateTime, formatDuration, isTerminal } from '../utils/format.js';

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

function Field({ label, children }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// One deployment: its facts, error and live logs. `stream` comes from
// useDeploymentStream; its deployment is what the server last sent.
export default function DeploymentDetails({ stream, number, onClose }) {
  const { deployment, logs, connection, ended, error } = stream;
  const now = useNow(deployment && !isTerminal(deployment.status));

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

      <StatusSteps status={deployment.status} />

      <dl className="details__grid">
        <Field label="Status">
          <StatusBadge status={deployment.status} />
        </Field>
        <Field label="Commit">
          <span className="mono">{deployment.commit_sha ?? 'branch head (resolved when built)'}</span>
        </Field>
        <Field label="Branch">
          <span className="mono">{deployment.branch}</span>
        </Field>
        <Field label="Created">{formatDateTime(deployment.created_at)}</Field>
        <Field label="Started">{formatDateTime(deployment.started_at)}</Field>
        <Field label="Finished">{formatDateTime(deployment.finished_at)}</Field>
        <Field label="Duration">{formatDuration(deployment.started_at, deployment.finished_at, now)}</Field>
        <Field label="Image">
          <span className="mono">{deployment.docker_image ?? '—'}</span>
        </Field>
        <Field label="Container">
          <span className="mono">
            {deployment.container_name
              ? `${deployment.container_name}${deployment.container_removed_at ? ' (removed)' : ''}`
              : '—'}
          </span>
        </Field>
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

      {deployment.status === 'FAILED' && (
        <div className="notice notice--error" role="alert">
          <strong>Error</strong>
          <div>{deployment.error_message ?? 'The deployment failed (see the logs).'}</div>
        </div>
      )}

      <LogViewer logs={logs} connection={connection} status={deployment.status} ended={ended} />
    </section>
  );
}
