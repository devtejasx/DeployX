// HTTP hardening: security headers, CORS, cross-site request protection,
// body limits, safe error responses and the production configuration check.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pool, projectPayload, setupTestServer } from './helpers.js';
import config, { productionConfigProblems } from '../src/config/index.js';

let api;
const DASHBOARD = 'http://localhost:3000'; // CLIENT_URL default
const EVIL = 'https://evil.example';

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

async function projectCount() {
  return (await pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n;
}

describe('security headers', () => {
  test('every API response carries a deny-all CSP and the standard hardening headers', async () => {
    for (const response of [await api.get('/api/projects'), await api.anonymous.get('/api/health'), await api.get('/api/nope')]) {
      const h = response.headers;
      assert.equal(h.get('content-security-policy'), "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'");
      assert.equal(h.get('x-content-type-options'), 'nosniff');
      assert.equal(h.get('x-frame-options'), 'DENY');
      assert.equal(h.get('referrer-policy'), 'no-referrer');
      assert.equal(h.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(h.get('cache-control'), 'no-store');
      assert.equal(h.get('x-powered-by'), null);
      // HSTS only in production (served over HTTPS there).
      assert.equal(h.get('strict-transport-security'), null);
    }
  });
});

describe('CORS', () => {
  test('the dashboard origin is allowed with credentials; others get no CORS headers', async () => {
    const allowed = await api.get('/api/projects', { headers: { origin: DASHBOARD } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), DASHBOARD);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

    for (const origin of [EVIL, 'null', 'http://localhost:3000.evil.example', 'http://localhost:30000']) {
      const refused = await api.get('/api/projects', { headers: { origin } });
      assert.equal(refused.headers.get('access-control-allow-origin'), null, origin);
    }
    assert.ok(!config.clientOrigins.includes('*'));
  });

  test('preflights are answered for the dashboard only', async () => {
    const preflight = (origin) =>
      api.anonymous.request('OPTIONS', '/api/projects', undefined, {
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
    const ok = await preflight(DASHBOARD);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), DASHBOARD);
    assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
    const evil = await preflight(EVIL);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  });
});

describe('cross-site request forgery', () => {
  test('state-changing requests from a foreign origin are refused, even with a valid session', async () => {
    const before = await projectCount();
    for (const headers of [{ origin: EVIL }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await api.post('/api/projects', projectPayload(), { headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.body.error.code, 'CROSS_ORIGIN_REQUEST');
    }
    assert.equal(await projectCount(), before);

    // The dashboard (through its proxy or directly) and non-browser clients still work.
    assert.equal((await api.post('/api/projects', projectPayload(), { headers: { origin: DASHBOARD } })).status, 201);
    assert.equal((await api.post('/api/projects', projectPayload(), { headers: { 'sec-fetch-site': 'same-origin' } })).status, 201);
    assert.equal((await api.post('/api/projects', projectPayload())).status, 201);
    // Reads are not affected.
    assert.equal((await api.get('/api/projects', { headers: { origin: EVIL } })).status, 200);
  });

  test('form-encoded and text bodies are refused before they are read (415)', async () => {
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
      const response = await api.post('/api/projects', undefined, { rawBody: 'name=x', headers: { 'content-type': contentType } });
      assert.equal(response.status, 415, contentType);
      assert.equal(response.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    }
  });

  test('sign-out cannot be forced cross-site either', async () => {
    const response = await api.post('/api/auth/logout', undefined, { headers: { origin: EVIL } });
    assert.equal(response.status, 403);
    assert.equal((await api.get('/api/auth/me')).status, 200, 'still signed in');
  });
});

describe('input limits and error responses', () => {
  test('oversized bodies are refused with 413', async () => {
    const response = await api.post('/api/projects', { ...projectPayload(), description: 'x'.repeat(200 * 1024) });
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  });

  test('non-object JSON, prototype keys and injection-looking values are rejected or stored inertly', async () => {
    for (const rawBody of ['[]', '"text"', '42', 'null']) {
      const response = await api.post('/api/projects', undefined, { rawBody });
      assert.equal(response.status, 400, rawBody);
    }
    const proto = await api.post('/api/projects', undefined, {
      rawBody: JSON.stringify({ ...projectPayload(), __proto__: { role: 'ADMIN' } }).replace('"name"', '"__proto__":{"role":"ADMIN"},"name"'),
    });
    assert.equal(proto.status, 400);
    assert.deepEqual(proto.body.error.details, ['Unknown or read-only field(s): __proto__']);

    const sql = await api.post('/api/projects', { ...projectPayload(), name: "x'; DROP TABLE users; --" });
    assert.equal(sql.status, 201);
    assert.equal(sql.body.data.name, "x'; DROP TABLE users; --");
    assert.ok((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n > 0);
  });

  test('every error has a stable code; internals never leak', async () => {
    const cases = [
      [await api.get('/api/projects/not-a-uuid'), 400, 'VALIDATION_FAILED'],
      [await api.anonymous.get('/api/projects'), 401, 'UNAUTHORIZED'],
      [await api.get('/api/projects/00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND'],
      [await api.post('/api/projects', undefined, { rawBody: '{"name": ' }), 400, 'BAD_REQUEST'],
    ];
    for (const [response, status, code] of cases) {
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, code);
      assert.ok(!/stack|node_modules|[A-Z]:\\|\/src\/|postgres(ql)?:\/\//i.test(JSON.stringify(response.body)), JSON.stringify(response.body));
    }
    const long = await api.get(`/api/${'a'.repeat(5000)}`);
    assert.ok(long.body.error.message.length < 250, 'echoed paths are clipped');
  });
});

describe('production configuration check', () => {
  const safe = {
    databaseUrl: 'postgresql://deployx:Str0ng-db-pass@db.internal:5432/deployx',
    redisUrl: 'rediss://:Str0ng-redis-pass@cache.internal:6380',
    clientOrigins: ['https://deployx.example.com'],
    auth: { cookieSecure: true, passwordHashCost: 17 },
    github: { webhookSecret: 'a'.repeat(40) },
  };

  test('accepts a safe configuration', () => {
    assert.deepEqual(productionConfigProblems(safe, 'https://deployx.example.com'), []);
  });

  test('lists every development default that must not reach production', () => {
    const problems = productionConfigProblems(
      {
        databaseUrl: 'postgresql://deployx:deployx@postgres:5432/deployx',
        redisUrl: 'redis://redis:6379',
        clientOrigins: ['http://deployx.example.com'],
        auth: { cookieSecure: false, passwordHashCost: 12 },
        github: { webhookSecret: 'short' },
      },
      '*,http://deployx.example.com',
    );
    assert.deepEqual(problems, [
      'DATABASE_URL uses a missing or development password',
      'REDIS_URL has no password or the development one',
      'CLIENT_URL must list origins, not "*"',
      'CLIENT_URL origin http://deployx.example.com is not HTTPS',
      'SESSION_COOKIE_SECURE must not be false',
      'PASSWORD_HASH_COST must be at least 15',
      'GITHUB_WEBHOOK_SECRET is too short (use at least 20 random characters)',
    ]);
    assert.deepEqual(productionConfigProblems({ ...safe }, null), ['CLIENT_URL is not set']);
  });
});
