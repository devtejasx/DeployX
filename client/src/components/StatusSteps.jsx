// The deployment lifecycle as steps: QUEUED -> BUILDING -> DEPLOYING -> SUCCESS.
// Steps before the current one are done. A FAILED deployment shows FAILED as
// its final step; which stage failed is told by the error and the logs.
const STEPS = ['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS'];

export default function StatusSteps({ status }) {
  const failed = status === 'FAILED';
  const current = failed ? STEPS.length - 1 : Math.max(STEPS.indexOf(status), 0);

  return (
    <ol className="steps" aria-label="Deployment progress">
      {STEPS.map((step, index) => {
        const last = index === STEPS.length - 1;
        let state = 'todo';
        if (!failed && index < current) state = 'done';
        if (index === current) state = failed ? 'failed' : step === 'SUCCESS' ? 'done' : 'current';
        return (
          <li
            key={step}
            className={`steps__step steps__step--${state}`}
            aria-current={index === current ? 'step' : undefined}
          >
            <span className="steps__dot" aria-hidden="true" />
            {failed && last ? 'FAILED' : step}
          </li>
        );
      })}
    </ol>
  );
}
