// Creating an application from the dashboard: the form sends what the API
// expects, shows the API's validation messages as they are, and opens the
// new application once it is stored.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import { formatDateTime, formatDayTime, formatTime } from '../src/utils/format.js';
import { SYSTEM_STATUS, fail, fakeApi, ok, overview } from './fakeApi.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'USER' };
const PROJECT = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'hello',
  github_repo: 'https://github.com/devtejasx/DeployX',
  github_branch: 'main',
  dockerfile_path: 'examples/hello-app/Dockerfile',
  container_port: 3000,
  health_check_path: '/health',
  deployment_target: 'LOCAL',
  status: 'ACTIVE',
};

function routes(extra = {}) {
  return {
    'GET /api/auth/me': ok({ user: USER }),
    'GET /api/system/status': SYSTEM_STATUS,
    'GET /api/monitoring/overview': ok(overview()),
    ...extra,
  };
}

function type(form, label, value) {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });
}

async function openForm() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create your first application' }));
  return screen.getByRole('region', { name: 'New application' });
}

describe('new application', () => {
  test('the empty list offers the form instead of an API call', async () => {
    fakeApi(routes({ 'GET /api/projects': ok([]) }));
    const form = await openForm();
    expect(within(form).getByLabelText('Branch').value).toBe('main');
    expect(within(form).getByLabelText('Dockerfile path').value).toBe('Dockerfile');
    expect(within(form).getByLabelText('Health-check path').value).toBe('/health');
    expect(screen.queryByText(/POST \/api\/projects/)).toBeNull();
  });

  test('creating sends the fields and opens the new application', async () => {
    let stored = [];
    const { calls } = fakeApi(
      routes({
        'GET /api/projects': () => ok(stored),
        'POST /api/projects': () => {
          stored = [PROJECT];
          return ok(PROJECT, 201);
        },
        [`GET /api/projects/${PROJECT.id}/deployments`]: ok([]),
      }),
    );
    const form = await openForm();
    type(form, 'Name', 'hello');
    type(form, 'Repository URL', 'https://github.com/devtejasx/DeployX');
    type(form, 'Dockerfile path', 'examples/hello-app/Dockerfile');
    type(form, 'Container port', '3000');
    fireEvent.click(within(form).getByRole('button', { name: 'Create application' }));

    expect(await screen.findByRole('heading', { name: 'Deployments · hello' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'New application' })).toBeNull();
    expect(window.location.hash).toBe(`#/projects/${PROJECT.id}`);
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/projects');
    expect(JSON.parse(post.options.body)).toEqual({
      name: 'hello',
      github_repo: 'https://github.com/devtejasx/DeployX',
      github_branch: 'main',
      dockerfile_path: 'examples/hello-app/Dockerfile',
      container_port: 3000,
      health_check_path: '/health',
    });
  });

  test("the API's validation messages are shown and the form stays open", async () => {
    fakeApi(
      routes({
        'GET /api/projects': ok([]),
        'POST /api/projects': fail(400, 'VALIDATION_FAILED', 'Validation failed', [
          'GitHub repository URL must look like https://github.com/<owner>/<repo>',
          'Dockerfile path must be a relative path inside the repository (no leading "/" or "..")',
        ]),
      }),
    );
    const form = await openForm();
    type(form, 'Name', 'hello');
    type(form, 'Repository URL', 'https://gitlab.com/a/b');
    type(form, 'Dockerfile path', '../Dockerfile');
    type(form, 'Container port', '3000');
    fireEvent.click(within(form).getByRole('button', { name: 'Create application' }));

    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain('Could not create the application');
    expect(alert.textContent).toContain('GitHub repository URL must look like');
    expect(alert.textContent).toContain('Dockerfile path must be a relative path');
    expect(within(form).getByLabelText('Name').value).toBe('hello');
  });
});

describe('application settings', () => {
  test('the Dockerfile path, container port and health-check path can be changed', async () => {
    let stored = PROJECT;
    const { calls } = fakeApi(
      routes({
        'GET /api/projects': () => ok([stored]),
        [`PUT /api/projects/${PROJECT.id}`]: ({ body }) => {
          stored = { ...stored, ...body };
          return ok(stored);
        },
        [`GET /api/projects/${PROJECT.id}/deployments`]: ok([]),
      }),
    );
    window.location.hash = `#/projects/${PROJECT.id}`;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const form = screen.getByRole('region', { name: 'Settings · hello' });
    expect(within(form).getByLabelText('Container port').value).toBe('3000');
    type(form, 'Dockerfile path', 'examples/unhealthy-app/Dockerfile');
    type(form, 'Container port', '8080');
    type(form, 'Health-check path', '/ready');
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await within(form).findByRole('status')).toBeTruthy();
    const put = calls.find((call) => call.method === 'PUT');
    expect(JSON.parse(put.options.body)).toMatchObject({
      dockerfile_path: 'examples/unhealthy-app/Dockerfile',
      container_port: 8080,
      health_check_path: '/ready',
    });
    expect(within(form).getByLabelText('Dockerfile path').value).toBe('examples/unhealthy-app/Dockerfile');
  });
});

describe('empty states and times', () => {
  test('with no applications only the list explains what to do', async () => {
    fakeApi(routes({ 'GET /api/projects': ok([]) }));
    render(<App />);
    await screen.findByRole('button', { name: 'Create your first application' });
    expect(screen.queryByText('Select an application to see its deployments.')).toBeNull();
  });

  test('an application without deployments says what Deploy does', async () => {
    fakeApi(
      routes({
        'GET /api/projects': ok([PROJECT]),
        [`GET /api/projects/${PROJECT.id}/deployments`]: ok([]),
      }),
    );
    window.location.hash = `#/projects/${PROJECT.id}`;
    render(<App />);
    expect((await screen.findByText(/No deployments yet/)).textContent).toContain('builds the head of main');
  });

  test('system status and monitoring show times in the same format', async () => {
    fakeApi(routes({ 'GET /api/projects': ok([]) }));
    render(<App />);
    const checked = await screen.findByText(/^Last checked /);
    const updated = await screen.findByText(/^Updated /);
    // Both come from the same timestamp in the fake API.
    expect(checked.textContent.replace('Last checked ', '')).toBe(updated.textContent.replace('Updated ', ''));
  });
});

describe('deployment history', () => {
  test('times are short so every column fits, with the full date in the tooltip', async () => {
    const deployment = {
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      project_id: PROJECT.id,
      status: 'SUCCESS',
      trigger: 'MANUAL',
      deployment_target: 'LOCAL',
      commit_sha: 'fa0221c1c14cdf37eb62b74615188684c437432d',
      created_at: '2026-10-13T12:52:18Z',
      started_at: '2026-10-13T12:52:18Z',
      finished_at: '2026-10-13T12:52:31Z',
      is_stable: true,
    };
    fakeApi(
      routes({
        'GET /api/projects': ok([PROJECT]),
        [`GET /api/projects/${PROJECT.id}/deployments`]: ok([deployment]),
      }),
    );
    window.location.hash = `#/projects/${PROJECT.id}`;
    render(<App />);
    const row = (await screen.findByText('#1')).closest('tr');
    const cells = within(row).getAllByRole('cell');
    const finished = cells.at(-2);
    expect(finished.textContent).toBe(formatTime(deployment.finished_at));
    expect(finished.getAttribute('title')).toBe(formatDateTime(deployment.finished_at));
    expect(cells.at(-1).textContent).toBe('13s');
    const created = cells.at(-4);
    expect(created.textContent).toBe(formatDayTime(deployment.created_at));
    expect(created.getAttribute('title')).toBe(formatDateTime(deployment.created_at));
  });
});
