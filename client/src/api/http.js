const API_BASE = '/api';

export class ApiRequestError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

// Calls the DeployX API and unwraps its { success, data } / { success: false,
// error } envelope: resolves with `data`, or throws ApiRequestError carrying
// the API's error message.
export async function apiRequest(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON response, e.g. the dev proxy answering 502 when the API is down.
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
