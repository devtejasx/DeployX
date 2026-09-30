// Final statuses. ROLLBACK_FAILED: the deployment was unhealthy and the last
// stable version could not be restored either.
export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'ROLLBACK_FAILED'];

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatDateTime(value) {
  return value ? dateTimeFormat.format(new Date(value)) : '—';
}

export function formatTime(value) {
  return value ? timeFormat.format(new Date(value)) : '';
}

// "53s", "4m 07s", "1h 02m". A running deployment is measured up to `now`.
export function formatDuration(startedAt, finishedAt, now = Date.now()) {
  if (!startedAt) return '—';
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '—';
}

export function shortId(id) {
  return id ? id.slice(0, 8) : '';
}

// What created a deployment (deployments.trigger).
const TRIGGERS = { MANUAL: 'Manual', GITHUB_PUSH: 'GitHub push' };

export function triggerLabel(trigger) {
  return TRIGGERS[trigger] ?? trigger ?? '—';
}

// Where a project's deployments run (deployment_target).
const TARGETS = { LOCAL: 'Local Docker', AWS_ECS: 'AWS ECS' };

export function targetLabel(target) {
  return TARGETS[target] ?? target ?? '—';
}

// "owner/repo" of https://github.com/owner/repo.
export function repositoryName(url) {
  return (url ?? '').replace(/^https:\/\/github\.com\//, '');
}

// "sha256:3f9a0c1d2e4b…" of an image digest.
export function shortDigest(digest) {
  return digest ? `${digest.slice(0, 19)}…` : '—';
}

// "my-app:7" of an ECS task definition ARN.
export function taskDefinitionName(arn) {
  return arn ? arn.split('/').pop() : '—';
}
