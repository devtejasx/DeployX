import { shortId } from '../utils/format.js';

const OUTCOMES = {
  COMPLETED: { icon: '✓', text: 'Completed', tone: 'ok' },
  FAILED: { icon: '✗', text: 'Failed', tone: 'error' },
  NOT_AVAILABLE: { icon: '–', text: 'Not available', tone: 'neutral' },
};

// Outcome of the automatic rollback of a deployment that failed its health
// check, exactly as the API reports it (rollback_status and
// rollback_deployment_id). Renders nothing for every other deployment.
export default function RollbackSummary({ deployment, numberOf, onSelect }) {
  const outcome = OUTCOMES[deployment.rollback_status];
  if (!outcome) return null;

  const targetId = deployment.rollback_deployment_id;
  const targetNumber = targetId ? numberOf(targetId) : null;

  return (
    <div className={`rollback rollback--${outcome.tone}`}>
      <dl className="rollback__grid">
        <div className="field">
          <dt>Automatic rollback</dt>
          <dd className="rollback__outcome">
            <span aria-hidden="true">{outcome.icon}</span> {outcome.text}
          </dd>
        </div>
        {targetId && (
          <div className="field">
            <dt>{deployment.rollback_status === 'COMPLETED' ? 'Restored deployment' : 'Rollback target'}</dt>
            <dd>
              <button type="button" className="link-button" onClick={() => onSelect(targetId)}>
                {targetNumber ? `#${targetNumber}` : shortId(targetId)}
              </button>{' '}
              {targetNumber && <span className="muted mono">{shortId(targetId)}</span>}
            </dd>
          </div>
        )}
      </dl>
      {deployment.rollback_status === 'COMPLETED' && (
        <p className="rollback__note">The previous stable version passed its health check and is live again.</p>
      )}
      {deployment.rollback_status === 'FAILED' && (
        <p className="rollback__note">The previous stable version could not be restored. See the error and the logs.</p>
      )}
      {deployment.rollback_status === 'NOT_AVAILABLE' && (
        <p className="rollback__note">No previous stable deployment available for rollback.</p>
      )}
    </div>
  );
}
