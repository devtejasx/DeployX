// The API client: envelope handling, error codes, cookies, and signing the
// dashboard out on 401.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiRequestError, UNAUTHORIZED_EVENT, apiRequest } from '../src/api/http.js';
import { fail, fakeApi, ok } from './fakeApi.js';

afterEach(() => vi.unstubAllGlobals());

describe('apiRequest', () => {
  test('unwraps data and sends JSON with the same-origin session cookie only', async () => {
    const { calls } = fakeApi({ 'POST /api/projects': ok({ id: 'p1' }, 201) });
    await expect(apiRequest('/projects', { method: 'POST', body: { name: 'x' } })).resolves.toEqual({ id: 'p1' });
    expect(calls[0].options.credentials).toBe('same-origin');
    expect(calls[0].options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(calls[0].options.headers.Authorization).toBeUndefined();
    expect(calls[0].url).toBe('/api/projects');
  });

  test('throws the API error with its code, status and details', async () => {
    fakeApi({ 'POST /api/projects': fail(400, 'VALIDATION_FAILED', 'Validation failed', ['Project name is required']) });
    const error = await apiRequest('/projects', { method: 'POST', body: {} }).catch((err) => err);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.body.error.details).toEqual(['Project name is required']);
  });

  test('a 401 from the API signs the dashboard out; failed sign-ins do not', async () => {
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);
    fakeApi({
      'GET /api/projects': fail(401, 'UNAUTHORIZED', 'Authentication required'),
      'POST /api/auth/login': fail(401, 'UNAUTHORIZED', 'Invalid email or password'),
    });
    await expect(apiRequest('/projects')).rejects.toThrow('Authentication required');
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(apiRequest('/auth/login', { method: 'POST', body: {} })).rejects.toThrow('Invalid email or password');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });

  test('a non-JSON answer (API down behind the proxy) becomes a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
    await expect(apiRequest('/projects')).rejects.toThrow('API unreachable (HTTP 502)');
  });
});
