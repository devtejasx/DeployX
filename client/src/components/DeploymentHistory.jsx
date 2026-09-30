import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';
import { formatDateTime, formatDuration, shortId, shortSha } from '../utils/format.js';

// What the automatic rollback of a deployment did, in a few words.
function rollbackNote(deployment, numberOf) {
  switch (deployment.rollback_status) {
    case 'COMPLETED':
      return `Automatic rollback completed · restored #${numberOf(deployment.rollback_deployment_id)}`;
    case 'FAILED':
      return 'Automatic rollback failed';
    case 'NOT_AVAILABLE':
      return 'No stable version to roll back to';
    default:
      return null;
  }
}

// Deployments of one application, newest first (the API's order). Numbers
// count from the oldest deployment (#1).
export default function DeploymentHistory({ project, deployments, error, loading, selectedId, onSelect, onDeploy }) {
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState(null);

  function numberOf(id) {
    const index = deployments.findIndex((deployment) => deployment.id === id);
    return index >= 0 ? deployments.length - index : '?';
  }

  async function deploy() {
    setDeploying(true);
    setDeployError(null);
    try {
      await onDeploy();
    } catch (err) {
      setDeployError(err.message);
    }
    setDeploying(false);
  }

  return (
    <section className="card history" aria-labelledby="history-heading">
      <div className="card__header">
        <h2 id="history-heading">Deployments · {project.name}</h2>
        <button type="button" onClick={deploy} disabled={deploying || project.status !== 'ACTIVE'}>
          {deploying ? 'Queueing…' : 'Deploy'}
        </button>
      </div>
      <p className="muted history__meta">
        {project.github_repo} · branch <code>{project.github_branch}</code> · <code>{project.dockerfile_path}</code>
        {project.container_port ? ` · port ${project.container_port}` : ''}
        {project.health_check_path && (
          <>
            {' '}
            · health check <code>{project.health_check_path}</code>
          </>
        )}
      </p>

      {deployError && <p className="notice notice--error">{deployError}</p>}
      {error && <p className="notice notice--error">Could not load deployments: {error}</p>}
      {!error && loading && !deployments && <p className="muted">Loading…</p>}
      {deployments?.length === 0 && <p className="muted">No deployments yet.</p>}

      {deployments?.length > 0 && (
        <div className="table-scroll">
          <table className="history__table">
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Commit</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((deployment, index) => (
                <tr
                  key={deployment.id}
                  className={deployment.id === selectedId ? 'history__row history__row--selected' : 'history__row'}
                  onClick={() => onSelect(deployment.id)}
                >
                  <td>
                    <button type="button" className="link-button" onClick={() => onSelect(deployment.id)}>
                      #{deployments.length - index}
                    </button>{' '}
                    <span className="muted mono">{shortId(deployment.id)}</span>
                  </td>
                  <td className="mono">{shortSha(deployment.commit_sha)}</td>
                  <td>
                    <StatusBadge status={deployment.status} />
                    {deployment.is_stable && (
                      <span className="tag tag--stable" title="The last stable deployment: the live version">
                        Stable
                      </span>
                    )}
                    {deployment.rollback_status && (
                      <div className={`history__rollback history__rollback--${deployment.rollback_status.toLowerCase()}`}>
                        {rollbackNote(deployment, numberOf)}
                      </div>
                    )}
                    {deployment.error_message && (
                      <div className="history__error" title={deployment.error_message}>
                        {deployment.error_message}
                      </div>
                    )}
                  </td>
                  <td>{formatDateTime(deployment.created_at)}</td>
                  <td>{formatDateTime(deployment.started_at)}</td>
                  <td>{formatDateTime(deployment.finished_at)}</td>
                  <td>{formatDuration(deployment.started_at, deployment.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
