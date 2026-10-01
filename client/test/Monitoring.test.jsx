// The monitoring panel shows exactly what the API reports, and says so when
// a source is unavailable instead of showing zeros.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import Monitoring from '../src/components/Monitoring.jsx';
import { fail, fakeApi, ok, overview } from './fakeApi.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Monitoring', () => {
  test('alerts, application states, workers, queue and deployments come from the overview', async () => {
    fakeApi({ 'GET /api/monitoring/overview': ok(overview()) });
    render(<Monitoring />);

    const alert = await screen.findByText('1 deployment(s) could not be rolled back in the last 24 hours');
    expect(alert.closest('li').className).toContain('alert--critical');

    const states = screen.getByRole('list', { name: 'Applications by state' });
    const count = (label) => within(states).getByText(label).previousSibling.textContent;
    expect(count('Deploying')).toBe('1');
    expect(count('Rolling back')).toBe('0');
    expect(count('Rollback failed')).toBe('1');
    expect(count('Failed')).toBe('0');
    expect(count('Healthy')).toBe('3');

    expect(screen.getByText('host:1:abc')).toBeTruthy();
    expect(screen.getByText(/1\/2 job slots busy/)).toBeTruthy();
    expect(screen.getByText('Waiting').nextSibling.textContent).toBe('2');
    expect(screen.getByRole('link', { name: 'shop' }).getAttribute('href')).toBe('#/projects/p1/deployments/d1');
    expect(screen.getByRole('link', { name: 'api' }).getAttribute('href')).toBe('#/projects/p2/deployments/d2');
  });

  test('no alerts is said plainly', async () => {
    fakeApi({ 'GET /api/monitoring/overview': ok(overview({ alerts: [] })) });
    render(<Monitoring />);
    expect(await screen.findByText('No active alerts.')).toBeTruthy();
  });

  test('unavailable sources are shown as unavailable, never as zero workers or an empty queue', async () => {
    fakeApi({
      'GET /api/monitoring/overview': ok(
        overview({
          dependencies: { postgres: 'down', redis: 'down' },
          workers: null,
          queue: null,
          deployments: null,
          projects: null,
          alerts: [
            { id: 'POSTGRES_UNAVAILABLE', severity: 'critical', message: 'PostgreSQL is unreachable' },
            { id: 'REDIS_UNAVAILABLE', severity: 'critical', message: 'Redis is unreachable' },
          ],
        }),
      ),
    });
    render(<Monitoring />);
    expect(await screen.findByText('Deployment data unavailable: PostgreSQL is down.')).toBeTruthy();
    expect(screen.getAllByText('Unavailable (Redis is down).')).toHaveLength(2);
    expect(screen.queryByText(/job slots busy/)).toBeNull();
  });

  test('an API error is reported, not hidden', async () => {
    fakeApi({ 'GET /api/monitoring/overview': fail(500, 'INTERNAL_ERROR', 'Internal server error') });
    render(<Monitoring />);
    expect(await screen.findByText('Could not load monitoring data: Internal server error')).toBeTruthy();
  });
});
