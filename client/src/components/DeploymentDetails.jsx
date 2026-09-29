import StatusBadge from './StatusBadge.jsx';
import { formatDateTime, formatDuration, formatTime } from '../utils/format.js';

function Field({ label, children }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// One deployment: its facts, error and logs.
export default function DeploymentDetails({ deployment, number, logs, error, onClose }) {
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
        <Field label="Duration">{formatDuration(deployment.started_at, deployment.finished_at)}</Field>
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

      <h3>Logs</h3>
      <ol className="log-view" aria-label="Deployment logs">
        {logs.map((line) => (
          <li key={line.id} className={`log-line log-line--${line.level.toLowerCase()}`}>
            <time className="log-line__time" dateTime={line.created_at}>
              {formatTime(line.created_at)}
            </time>
            <span className="log-line__message">{line.message}</span>
          </li>
        ))}
        {logs.length === 0 && <li className="muted">No log lines yet.</li>}
      </ol>
    </section>
  );
}
