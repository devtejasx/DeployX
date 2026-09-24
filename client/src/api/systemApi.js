const API_BASE = '/api';

// GET /api/system/status answers 200 when every service is up and 503 when
// one is down. Both carry a status body, so only a missing body is an error.
export async function fetchSystemStatus({ signal } = {}) {
  const response = await fetch(`${API_BASE}/system/status`, { signal });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON response, e.g. the dev proxy answering 502 when the API is down.
  }

  if (!body || typeof body.api !== 'string') {
    throw new Error(`API unreachable (HTTP ${response.status})`);
  }

  return body;
}
