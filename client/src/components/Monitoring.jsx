import { fetchMonitoringOverview } from '../api/monitoringApi.js';
import { usePolling } from '../hooks/usePolling.js';
import { formatDateTime, formatTime } from '../utils/format.js';
import StatusBadge from './StatusBadge.jsx';

const always = () => true;

// Project states, in the order an operator cares about them.
const PROJECT_STATES = [
  ['deploying', 'Deploying'],
  ['rolling_back', 'Rolling back'],
  ['rollback_failed', 'Rollback failed'],
  ['failed', 'Failed'],
  ['rolled_back', 'Rolled back'],
  ['healthy', 'Healthy'],
];

function deploymentHref(deployment) {
  return `#/projects/${deployment.project_id}/deployments/${deployment.id}`;
}

function ago(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s ago`;
}

// The monitoring panel: everything comes from GET /api/monitoring/overview,
// which reads worker heartbeats and the queue from Redis and deployments from
// PostgreSQL. A source the API could not read is shown as unavailable - never
// as zero or as healthy.
export default function Monitoring() {
  const { data, error, loading } = usePolling(() => fetchMonitoringOverview(), [], {
    intervalMs: 5000,
    shouldPoll: always,
  });

  return (
    <section className="card monitoring" aria-labelledby="monitoring-heading">
      <div className="card__header">
        <h2 id="monitoring-heading">Monitoring</h2>
        {data && <span className="muted monitoring__time">Updated {formatTime(data.generatedAt)}</span>}
      </div>

      {error && <p className="notice notice--error">Could not load monitoring data: {error}</p>}
      {!data && !error && loading && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="monitoring__alerts" aria-live="polite">
            {data.alerts.length === 0 ? (
              <p className="notice notice--ok">No active alerts.</p>
            ) : (
              <ul className="alert-list">
                {data.alerts.map((alert) => (
                  <li key={`${alert.id}-${alert.message}`} className={`alert alert--${alert.severity}`}>
                    <span className="alert__severity">{alert.severity}</span>
                    <span className="alert__message">{alert.message}</span>
                    <code className="alert__id">{alert.id}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.projects ? (
            <ul className="stats" aria-label="Applications by state">
              {PROJECT_STATES.map(([state, label]) => (
                <li key={state} className={`stat stat--${state}`}>
                  <span className="stat__value">{data.projects.counts[state] ?? 0}</span>
                  <span className="stat__label">{label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notice notice--error">Deployment data unavailable: PostgreSQL is down.</p>
          )}

          <div className="monitoring__grid">
            <div>
              <h3>Workers</h3>
              {data.workers ? (
                <>
                  <p className="monitoring__summary">
                    <strong>{data.workers.running}</strong> running
                    {data.workers.stopping > 0 && <>, {data.workers.stopping} stopping</>} ·{' '}
                    {data.workers.activeJobs}/{data.workers.capacity} job slots busy
                  </p>
                  <ul className="worker-list">
                    {data.workers.list.map((worker) => (
                      <li key={worker.id} className={`worker worker--${worker.status}`}>
                        <span className="worker__dot" aria-hidden="true" />
                        <span className="mono worker__id" title={worker.hostname ?? worker.id}>
                          {worker.id}
                        </span>
                        <span className="muted">
                          {worker.status} · {worker.activeJobs}/{worker.concurrency} jobs · heartbeat{' '}
                          {ago(worker.heartbeatAgeSeconds)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {data.workers.list.length === 0 && <p className="muted">No worker heartbeat.</p>}
                </>
              ) : (
                <p className="muted">Unavailable (Redis is down).</p>
              )}
            </div>

            <div>
              <h3>Queue</h3>
              {data.queue ? (
                <dl className="queue-stats">
                  <dt>Waiting</dt>
                  <dd>{data.queue.waiting}</dd>
                  <dt>Running</dt>
                  <dd>{data.queue.active}</dd>
                  <dt>Retry pending</dt>
                  <dd>{data.queue.delayed}</dd>
                  <dt>Failed jobs kept</dt>
                  <dd>{data.queue.failed}</dd>
                </dl>
              ) : (
                <p className="muted">Unavailable (Redis is down).</p>
              )}
              <p className="muted monitoring__deps">
                PostgreSQL {data.dependencies.postgres} · Redis {data.dependencies.redis}
              </p>
            </div>

            {data.deployments && (
              <div>
                <h3>Last 24 hours</h3>
                <dl className="queue-stats">
                  <dt>Succeeded</dt>
                  <dd>{data.deployments.last24Hours.SUCCESS ?? 0}</dd>
                  <dt>Failed</dt>
                  <dd>{data.deployments.last24Hours.FAILED ?? 0}</dd>
                  <dt>Rollback failed</dt>
                  <dd>{data.deployments.last24Hours.ROLLBACK_FAILED ?? 0}</dd>
                  <dt>Rollbacks</dt>
                  <dd>{data.deployments.rollbacksLast24Hours}</dd>
                </dl>
              </div>
            )}
          </div>

          {data.deployments && (
            <div className="monitoring__grid monitoring__grid--wide">
              <div>
                <h3>In progress</h3>
                {data.deployments.active.length === 0 ? (
                  <p className="muted">Nothing is deploying.</p>
                ) : (
                  <ul className="activity-list">
                    {data.deployments.active.map((deployment) => (
                      <li key={deployment.id}>
                        <StatusBadge status={deployment.status} />
                        <a href={deploymentHref(deployment)}>{deployment.project_name}</a>
                        <span className="muted">since {formatTime(deployment.updated_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3>Recent failures</h3>
                {data.deployments.recentFailures.length === 0 ? (
                  <p className="muted">No failed deployments.</p>
                ) : (
                  <ul className="activity-list">
                    {data.deployments.recentFailures.map((deployment) => (
                      <li key={deployment.id}>
                        <StatusBadge status={deployment.status} />
                        <a href={deploymentHref(deployment)}>{deployment.project_name}</a>
                        <span className="muted" title={deployment.error_message ?? undefined}>
                          {formatDateTime(deployment.finished_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
