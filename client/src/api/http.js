const API_BASE = '/api';

// Dispatched on `window` whenever the API answers 401 (the session ended or
// expired): the app then shows the sign-in form.
export const UNAUTHORIZED_EVENT = 'deployx:unauthorized';

export class ApiRequestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
    this.code = body?.error?.code ?? null;
  }
}

// Calls the DeployX API and unwraps its { success, data } / { success: false,
// error } envelope: resolves with `data`, or throws ApiRequestError carrying
// the API's error message and code.
//
// Authentication is the HttpOnly session cookie, which the browser sends by
// itself (same origin). The dashboard never sees or stores a token: nothing
// is kept in localStorage or sessionStorage, and nothing goes in a URL.
export async function apiRequest(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON response, e.g. the dev proxy answering 502 when the API is down.
  }

  if (response.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!response.ok || !payload?.success) {
    const message = payload?.error?.message ?? `API unreachable (HTTP ${response.status})`;
    throw new ApiRequestError(message, response.status, payload);
  }
  return payload.data;
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}
