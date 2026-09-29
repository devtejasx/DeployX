import StatusRow from './StatusRow.jsx';
import { useSystemStatus } from '../hooks/useSystemStatus.js';

// The Phase 1 system status card (API, database, Redis), unchanged.
export default function SystemStatus() {
  const { status, error, loading, refresh } = useSystemStatus();

  // If the API itself cannot be reached we have no information about the
  // database or Redis, so they are shown as unknown rather than guessed.
  const apiState = status ? status.api : error ? 'disconnected' : 'unknown';
  const databaseState = status ? status.database : 'unknown';
  const redisState = status ? status.redis : 'unknown';

  return (
    <section className="card system-status" aria-labelledby="system-status-heading">
      <div className="card__header">
        <h2 id="system-status-heading">System Status</h2>
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      <ul className="status-list">
        <StatusRow name="API" state={apiState} detail={error} />
        <StatusRow name="Database" state={databaseState} detail={status?.errors?.database} />
        <StatusRow name="Redis" state={redisState} detail={status?.errors?.redis} />
      </ul>

      <p className="card__footer">
        {error && `Could not reach the API: ${error}`}
        {status && `Last checked ${new Date(status.checkedAt).toLocaleTimeString()}`}
      </p>
    </section>
  );
}
