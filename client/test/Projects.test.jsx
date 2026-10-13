// Creating an application from the dashboard: the form sends what the API
// expects, shows the API's validation messages as they are, and opens the
// new application once it is stored.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
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
