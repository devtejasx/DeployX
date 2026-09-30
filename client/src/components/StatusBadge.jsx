import { isTerminal } from '../utils/format.js';

// Deployment status as a coloured pill. Non-final statuses pulse; a rollback
// in progress shows a turning arrow instead of the dot.
export default function StatusBadge({ status }) {
  const running = !isTerminal(status) && status !== 'QUEUED';
  return (
    <span className={`badge badge--${status.toLowerCase()}${running ? ' badge--running' : ''}`}>
      {status === 'ROLLING_BACK' ? (
        <span className="badge__icon" aria-hidden="true">
          ↻
        </span>
      ) : (
        <span className="badge__dot" aria-hidden="true" />
      )}
      {status}
    </span>
  );
}
