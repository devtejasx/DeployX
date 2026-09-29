import { isTerminal } from '../utils/format.js';

// Deployment status as a coloured pill. Non-final statuses pulse.
export default function StatusBadge({ status }) {
  const running = !isTerminal(status) && status !== 'QUEUED';
  return (
    <span className={`badge badge--${status.toLowerCase()}${running ? ' badge--running' : ''}`}>
      <span className="badge__dot" aria-hidden="true" />
      {status}
    </span>
  );
}
