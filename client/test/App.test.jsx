// Authentication state in the dashboard: signed out shows only the sign-in
// form; signing in shows the dashboard; an expired session goes back to
// sign-in. Tokens are never stored by the page.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import App from '../src/App.jsx';
import { UNAUTHORIZED_EVENT } from '../src/api/http.js';
import { SYSTEM_STATUS, fail, fakeApi, ok, overview } from './fakeApi.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com', role: 'USER' };

function signedInRoutes(extra = {}) {
  return {
    'GET /api/system/status': SYSTEM_STATUS,
    'GET /api/monitoring/overview': ok(overview()),
    'GET /api/projects': ok([]),
    ...extra,
  };
}

function type(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('signed out', () => {
  test('only the sign-in form is shown; no project or monitoring data is requested', async () => {
    const { calls } = fakeApi({ 'GET /api/system/status': SYSTEM_STATUS, 'GET /api/auth/me': fail(401, 'UNAUTHORIZED', 'Authentication required') });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Monitoring')).toBeNull();
    expect(screen.queryByText('Applications')).toBeNull();
    expect(calls.map((call) => call.url)).not.toContain('/api/projects');
    expect(calls.map((call) => call.url)).not.toContain('/api/monitoring/overview');
  });

  test('signing in shows the dashboard and stores nothing in the browser', async () => {
    const { calls } = fakeApi({
      'GET /api/auth/me': fail(401, 'UNAUTHORIZED', 'Authentication required'),
      'POST /api/auth/login': ok({ user: USER }),
      ...signedInRoutes(),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Email', 'ada@example.com');
    type('Password', 'a long password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.getByText('USER')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Monitoring' })).toBeTruthy();
    const login = calls.find((call) => call.url === '/api/auth/login');
    expect(JSON.parse(login.options.body)).toEqual({ email: 'ada@example.com', password: 'a long password' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  test('wrong credentials show the API message and clear the password field', async () => {
    fakeApi({
      'GET /api/system/status': SYSTEM_STATUS,
      'GET /api/auth/me': fail(401, 'UNAUTHORIZED', 'Authentication required'),
      'POST /api/auth/login': fail(401, 'UNAUTHORIZED', 'Invalid email or password'),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Sign in' });
    type('Email', 'ada@example.com');
    type('Password', 'wrong password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid email or password');
    expect(screen.getByLabelText('Password').value).toBe('');
  });

  test('registration shows each validation message from the API', async () => {
    fakeApi({
      'GET /api/system/status': SYSTEM_STATUS,
      'GET /api/auth/me': fail(401, 'UNAUTHORIZED', 'Authentication required'),
      'POST /api/auth/register': fail(400, 'VALIDATION_FAILED', 'Validation failed', [
        'Email must be a valid email address',
        'Password must be at least 12 characters',
      ]),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }));
    type('Name', 'Ada');
    type('Email', 'ada@example.com');
    type('Password', 'x'.repeat(12));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Email must be a valid email address');
    expect(alert.textContent).toContain('Password must be at least 12 characters');
  });
});

describe('signed in', () => {
  test('an expired session (any 401) returns to the sign-in form', async () => {
    fakeApi({ 'GET /api/auth/me': ok({ user: USER }), ...signedInRoutes() });
    render(<App />);
    await screen.findByRole('heading', { name: 'Monitoring' });
    act(() => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Monitoring' })).toBeNull();
  });

  test('sign-out ends the session through the API', async () => {
    const { calls } = fakeApi({
      'GET /api/auth/me': ok({ user: USER }),
      'POST /api/auth/logout': ok({ signedOut: true }),
      ...signedInRoutes(),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(calls.some((call) => call.url === '/api/auth/logout' && call.options.method === 'POST')).toBe(true);
  });

  test('data from the API is rendered as text, never as HTML', async () => {
    const hostile = '<img src=x onerror="window.__xss = 1">';
    fakeApi({
      'GET /api/auth/me': ok({ user: { ...USER, name: hostile } }),
      ...signedInRoutes({
        'GET /api/projects': ok([
          { id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: hostile, github_repo: 'https://github.com/a/b', github_branch: 'main', deployment_target: 'LOCAL' },
        ]),
      }),
    });
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getAllByText(hostile).length).toBeGreaterThanOrEqual(2));
    expect(container.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });
});
