const STATES = {
  RUNNING: { icon: '●', text: 'Running', tone: 'running' },
  PASSED: { icon: '✓', text: 'Passed', tone: 'ok' },
  FAILED: { icon: '✗', text: 'Failed', tone: 'error' },
};

const REASONS = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function response(check) {
  if (check.status_code) {
    const reason = REASONS[check.status_code] ? ` ${REASONS[check.status_code]}` : '';
    const time = check.response_time == null ? '' : ` · ${check.response_time} ms`;
    return `${check.status_code}${reason}${time}`;
  }
  return check.attempts > 0 ? 'No HTTP response' : '—';
}

// The health check of a deployment, exactly as the worker recorded it
// (deployment.health_check). It is updated after every attempt, so this
// follows the check live. Renders nothing before a deployment reaches its
// health check.
export default function HealthCheckSummary({ check }) {
  const state = STATES[check?.status];
  if (!state) return null;

  return (
    <div className={`health health--${state.tone}`}>
      <dl className="health__grid">
        <div className="field">
          <dt>Health check</dt>
          <dd className="health__state">
            <span aria-hidden="true">{state.icon}</span> {state.text}
          </dd>
        </div>
        <div className="field">
          <dt>Attempt</dt>
          <dd>
            {check.attempts} / {check.max_attempts}
          </dd>
        </div>
        <div className="field">
          <dt>Response</dt>
          <dd>{response(check)}</dd>
        </div>
      </dl>
      {check.error && <p className="health__error">{check.error}</p>}
    </div>
  );
}
