// The deployment lifecycle as steps:
//   QUEUED -> BUILDING -> DEPLOYING -> HEALTH_CHECK -> SUCCESS
// Steps before the current one are done. Everything shown here is derived
// from what the API reports (status, health_check and rollback_status),
// nothing is assumed:
// - a deployment that is ROLLING_BACK or ROLLBACK_FAILED, or FAILED with a
//   failed health check, failed at the health check: that step is marked as
//   the failed one, followed by where the deployment is now
// - any other FAILED deployment shows FAILED as its final step; which stage
//   failed is told by the error and the logs.
const STEPS = ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS'];

function stepsFor(status, healthCheckFailed) {
  if (status === 'ROLLING_BACK' || status === 'ROLLBACK_FAILED' || (status === 'FAILED' && healthCheckFailed)) {
    return [
      { label: 'QUEUED', state: 'done' },
      { label: 'BUILDING', state: 'done' },
      { label: 'DEPLOYING', state: 'done' },
      { label: 'HEALTH_CHECK', state: 'failed' },
      { label: status, state: status === 'ROLLING_BACK' ? 'current' : 'failed' },
    ];
  }

  if (status === 'FAILED') {
    return STEPS.map((label, index) =>
      index === STEPS.length - 1 ? { label: 'FAILED', state: 'failed' } : { label, state: 'todo' },
    );
  }

  const current = Math.max(STEPS.indexOf(status), 0);
  return STEPS.map((label, index) => {
    if (index < current || (index === current && label === 'SUCCESS')) return { label, state: 'done' };
    return { label, state: index === current ? 'current' : 'todo' };
  });
}

export default function StatusSteps({ status, healthCheckFailed }) {
  return (
    <ol className="steps" aria-label="Deployment progress">
      {stepsFor(status, healthCheckFailed).map(({ label, state }) => (
        <li
          key={label}
          className={`steps__step steps__step--${state}`}
          aria-current={label === status ? 'step' : undefined}
        >
          <span className="steps__dot" aria-hidden="true" />
          {label}
        </li>
      ))}
    </ol>
  );
}
