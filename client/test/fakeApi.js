import { vi } from 'vitest';

// A fake of the DeployX API for component tests: `routes` maps
// "METHOD /api/path" to { status, body } (or a function returning one).
// Every call is recorded with its URL and fetch options.
export function fakeApi(routes) {
  const calls = [];
  const fetch = vi.fn(async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const path = String(url).split('?')[0];
    calls.push({ method, url: String(url), options });
    let route = routes[`${method} ${path}`];
    if (typeof route === 'function') route = route({ method, url, options, body: options.body && JSON.parse(options.body) });
    const { status = 200, body = null } = route ?? { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls };
}

export const ok = (data, status = 200) => ({ status, body: { success: true, data } });
export const fail = (status, code, message, details) => ({
  status,
  body: { success: false, error: { code, message, ...(details ? { details } : {}) } },
});

export const SYSTEM_STATUS = ok({ api: 'connected', database: 'connected', redis: 'connected', checkedAt: '2026-10-01T10:00:00Z' });

export function overview(overrides = {}) {
  return {
    generatedAt: '2026-10-01T10:00:00Z',
    dependencies: { postgres: 'up', redis: 'up' },
    workers: { running: 1, stopping: 0, activeJobs: 1, capacity: 2, list: [{ id: 'host:1:abc', status: 'running', activeJobs: 1, concurrency: 2, heartbeatAgeSeconds: 3 }] },
    queue: { waiting: 2, active: 1, delayed: 0, failed: 0, depth: 2 },
    deployments: {
      inProgress: { BUILDING: 1 },
      active: [{ id: 'd1', project_id: 'p1', project_name: 'shop', status: 'BUILDING', updated_at: '2026-10-01T09:59:00Z' }],
      last24Hours: { SUCCESS: 4, FAILED: 2, ROLLBACK_FAILED: 1 },
      lastHour: {},
      rollbacksLast24Hours: 3,
      recentFailures: [{ id: 'd2', project_id: 'p2', project_name: 'api', status: 'ROLLBACK_FAILED', finished_at: '2026-10-01T09:00:00Z', error_message: 'Health check failed' }],
      stuck: 0,
    },
    projects: { counts: { deploying: 1, rollback_failed: 1, healthy: 3 }, list: [] },
    alerts: [{ id: 'ROLLBACK_FAILED', severity: 'critical', message: '1 deployment(s) could not be rolled back in the last 24 hours' }],
    ...overrides,
  };
}
