// Authentication: accounts, password hashing, sessions and the sign-in API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_USER, TEST_PASSWORD, pool, projectPayload, setupTestServer, testDatabaseUrl } from './helpers.js';
import config from '../src/config/index.js';
import { hashPassword, needsRehash, verifyPassword } from '../src/services/password.js';

let api;
let counter = 0;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

function uniqueEmail(label = 'user') {
  counter += 1;
  return `${label}-${counter}@example.com`;
}

function sessionCookie(response) {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith('deployx_session='));
}

async function register(body) {
  return api.anonymous.post('/api/auth/register', body);
}

async function login(email, password = TEST_PASSWORD) {
  return api.anonymous.post('/api/auth/login', { email, password });
}

async function auditActions(email) {
  const { rows } = await pool.query(
    `SELECT a.action, a.details FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE u.email = $1 OR a.details->>'email' = $1 ORDER BY a.id`,
    [email],
  );
  return rows;
}

describe('password hashing', () => {
  test('hashes are salted scrypt hashes that verify only the right password', async () => {
    const first = await hashPassword('a long enough password');
    const second = await hashPassword('a long enough password');
    assert.match(first, /^scrypt\$12\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second, 'every hash has its own salt');
    assert.equal(await verifyPassword('a long enough password', first), true);
    assert.equal(await verifyPassword('a long enough passworD', first), false);
    assert.equal(await verifyPassword('anything', null), false);
    assert.equal(await verifyPassword('anything', 'not a hash'), false);
  });

  test('hashes weaker than the configured cost need a rehash', async () => {
    assert.equal(needsRehash(await hashPassword('x'.repeat(12), 10)), true);
    assert.equal(needsRehash(await hashPassword('x'.repeat(12))), false);
    assert.equal(needsRehash('garbage'), true);
  });
});

describe('registration', () => {
  test('creates a USER, signs it in with an HttpOnly SameSite=Strict cookie, and stores no plaintext', async () => {
    const email = uniqueEmail('new');
    const response = await register({ name: '  Ada  ', email: email.toUpperCase(), password: TEST_PASSWORD });
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body.data), ['user']);
    const { user } = response.body.data;
    assert.equal(user.name, 'Ada');
    assert.equal(user.email, email, 'emails are stored lower-case');
    assert.equal(user.role, 'USER', 'an ADMIN already exists');
    assert.ok(!('password_hash' in user));

    const cookie = sessionCookie(response);
    assert.ok(cookie, 'a session cookie is set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//);
    const token = cookie.split(';')[0].split('=')[1];
    assert.ok(!JSON.stringify(response.body).includes(token), 'the token is never in the body');

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    assert.match(rows[0].password_hash, /^scrypt\$/);
    assert.ok(!rows[0].password_hash.includes(TEST_PASSWORD));
    const sessions = await pool.query('SELECT token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1', [email]);
    assert.equal(sessions.rows.length, 1);
    assert.deepEqual(sessions.rows[0].token_hash, crypto.createHash('sha256').update(token).digest());

    const me = await api.anonymous.get('/api/auth/me', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.email, email);
    assert.deepEqual((await auditActions(email)).map((entry) => entry.action), ['auth.register']);
  });

  test('rejects weak passwords, invalid emails, unknown fields and taken emails', async () => {
    const weak = await register({ name: 'Weak', email: uniqueEmail(), password: 'short' });
    assert.equal(weak.status, 400);
    assert.deepEqual(weak.body.error.details, ['Password must be at least 12 characters']);

    const invalid = await register({ name: 'Bad', email: 'not-an-email', password: TEST_PASSWORD });
    assert.deepEqual(invalid.body.error.details, ['Email must be a valid email address']);

    const extra = await register({ name: 'Role', email: uniqueEmail(), password: TEST_PASSWORD, role: 'ADMIN' });
    assert.equal(extra.status, 400, 'the role can never be chosen by the client');
    assert.deepEqual(extra.body.error.details, ['Unknown or read-only field(s): role']);

    const tooLong = await register({ name: 'Long', email: uniqueEmail(), password: 'x'.repeat(257) });
    assert.deepEqual(tooLong.body.error.details, ['Password must be at most 256 characters']);

    const taken = await register({ name: 'Again', email: DEFAULT_USER.email, password: TEST_PASSWORD });
    assert.equal(taken.status, 409);
  });

  test('can be disabled (the production default)', async (t) => {
    t.after(() => {
      config.auth.allowRegistration = true;
    });
    config.auth.allowRegistration = false;
    const response = await register({ name: 'Closed', email: uniqueEmail(), password: TEST_PASSWORD });
    assert.equal(response.status, 403);
    assert.equal(sessionCookie({ headers: response.headers }), undefined);
  });

  test('the first account of an installation without an ADMIN becomes ADMIN, exactly once under concurrency', async (t) => {
    const { rows: admins } = await pool.query(`UPDATE users SET role = 'USER' WHERE role = 'ADMIN' RETURNING id`);
    t.after(() => pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = ANY($1::uuid[])`, [admins.map((row) => row.id)]));

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => register({ name: 'Racer', email: uniqueEmail('race'), password: TEST_PASSWORD })),
    );
    assert.deepEqual(responses.map((response) => response.status), [201, 201, 201, 201, 201]);
    const roles = responses.map((response) => response.body.data.user.role).sort();
    assert.deepEqual(roles, ['ADMIN', 'USER', 'USER', 'USER', 'USER']);
  });
});

describe('sign-in and sign-out', () => {
  test('a correct password starts a session; the user can then use the API', async () => {
    const email = uniqueEmail('login');
    await register({ name: 'Login', email, password: TEST_PASSWORD });

    const response = await login(email.toUpperCase());
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.email, email);
    const cookie = sessionCookie(response).split(';')[0];
    const projects = await api.anonymous.get('/api/projects', { headers: { cookie } });
    assert.equal(projects.status, 200);

    const { rows } = await pool.query('SELECT last_login_at FROM users WHERE email = $1', [email]);
    assert.ok(rows[0].last_login_at);
  });

  test('wrong passwords, unknown emails and accounts without a password get the same 401', async () => {
    const email = uniqueEmail('wrong');
    await register({ name: 'Wrong', email, password: TEST_PASSWORD });
    await pool.query(`INSERT INTO users (name, email) VALUES ('No password', 'nopassword@example.com')`);

    const responses = [
      await login(email, 'not the right password'),
      await login('nobody@example.com'),
      await login('nopassword@example.com', ''),
      await login('nopassword@example.com', 'whatever it is'),
    ];
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 400, 401]);
    for (const response of [responses[0], responses[1], responses[3]]) {
      assert.deepEqual(response.body.error.message, 'Invalid email or password');
      assert.equal(sessionCookie(response), undefined);
    }

    const audit = await auditActions(email);
    assert.deepEqual(audit.map((entry) => entry.action), ['auth.register', 'auth.login_failed']);
    assert.ok(!JSON.stringify(audit).includes('not the right password'), 'passwords are never audited');
  });

  test('a weaker hash is upgraded at the next sign-in', async () => {
    const email = uniqueEmail('rehash');
    await pool.query('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)', [
      'Old hash',
      email,
      await hashPassword(TEST_PASSWORD, 10),
    ]);
    assert.equal((await login(email)).status, 200);
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    assert.match(rows[0].password_hash, /^scrypt\$12\$/);
    assert.equal((await login(email)).status, 200, 'the new hash verifies');
  });

  test('sign-out ends the session on the server and clears the cookie', async () => {
    const client = await api.clientFor({ email: uniqueEmail('logout') });
    assert.equal((await client.get('/api/auth/me')).status, 200);

    const response = await client.post('/api/auth/logout');
    assert.equal(response.status, 200);
    assert.match(response.headers.getSetCookie().join(';'), /deployx_session=;/);
    assert.equal((await client.get('/api/auth/me')).status, 401, 'the old cookie no longer works');
    assert.equal((await client.get('/api/projects')).status, 401);
  });

  test('expired and idle sessions are refused', async () => {
    const expired = await api.clientFor({ email: uniqueEmail('expired') });
    await pool.query(
      `UPDATE sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
       WHERE user_id = $1`,
      [expired.user.id],
    );
    assert.equal((await expired.get('/api/projects')).status, 401);

    const idle = await api.clientFor({ email: uniqueEmail('idle') });
    await pool.query(
      `UPDATE sessions SET last_seen_at = now() - make_interval(mins => $2 + 1) WHERE user_id = $1`,
      [idle.user.id, config.auth.idleTimeoutMinutes],
    );
    assert.equal((await idle.get('/api/projects')).status, 401);
  });
});

describe('protected routes', () => {
  test('every resource route needs a session; health and status do not', async () => {
    const { body } = await api.post('/api/projects', projectPayload());
    const projectId = body.data.id;
    const { deployment } = (await api.post(`/api/projects/${projectId}/deployments`, {})).body.data;

    for (const [method, path] of [
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['GET', `/api/projects/${projectId}`],
      ['PUT', `/api/projects/${projectId}`],
      ['DELETE', `/api/projects/${projectId}`],
      ['GET', `/api/projects/${projectId}/deployments`],
      ['POST', `/api/projects/${projectId}/deployments`],
      ['GET', `/api/deployments/${deployment.id}`],
      ['PATCH', `/api/deployments/${deployment.id}/status`],
      ['GET', `/api/deployments/${deployment.id}/logs`],
      ['POST', `/api/deployments/${deployment.id}/logs`],
      ['GET', `/api/deployments/${deployment.id}/logs/stream`],
      ['GET', '/api/auth/me'],
    ]) {
      for (const cookie of [undefined, 'deployx_session=forged-token', `deployx_session=${'A'.repeat(43)}`]) {
        const response = await api.anonymous.request(method, path, method === 'GET' || method === 'DELETE' ? undefined : {}, {
          headers: cookie ? { cookie } : {},
        });
        assert.equal(response.status, 401, `${method} ${path} with ${cookie ?? 'no cookie'}`);
        assert.equal(response.body.error.message, 'Authentication required');
      }
    }
    assert.equal((await api.anonymous.get('/api/health')).status, 200);
    assert.notEqual((await api.anonymous.get('/api/system/status')).status, 401);
  });

  test('the session token is only read from the cookie, never from the URL or an Authorization header', async () => {
    const email = uniqueEmail('url');
    const response = await register({ name: 'URL', email, password: TEST_PASSWORD });
    const token = sessionCookie(response).split(';')[0].split('=')[1];
    assert.equal((await api.anonymous.get(`/api/projects?session=${token}&token=${token}`)).status, 401);
    assert.equal(
      (await api.anonymous.get('/api/projects', { headers: { authorization: `Bearer ${token}` } })).status,
      401,
    );
  });
});

describe('npm run user:create', () => {
  function runCli(args, { password, stdin } = {}) {
    const script = fileURLToPath(new URL('../src/scripts/createUser.js', import.meta.url));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: {
          ...process.env,
          DATABASE_URL: testDatabaseUrl,
          PASSWORD_HASH_COST: '12',
          DEPLOYX_USER_PASSWORD: password ?? '',
        },
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.stdin.end(stdin ?? '');
      child.on('close', (code) => resolve({ code, output }));
    });
  }

  test('creates an administrator from a password on stdin, and updates an existing account', async () => {
    const email = uniqueEmail('cli');
    const password = 'a cli password that is long';
    const created = await runCli(['--email', email, '--name', 'CLI Admin', '--role', 'admin'], { stdin: `${password}\n` });
    assert.equal(created.code, 0, created.output);
    assert.match(created.output, new RegExp(`Created ${email} \\(ADMIN`));
    assert.ok(!created.output.includes(password), 'the password is never printed');
    assert.equal((await login(email, password)).status, 200);

    // The pre-Phase 8 development user has no password; the CLI gives it one.
    await pool.query(`INSERT INTO users (name, email) VALUES ('Dev', 'dev@deployx.local') ON CONFLICT DO NOTHING`);
    const updated = await runCli(['--email', 'dev@deployx.local'], { password: 'the new dev password' });
    assert.equal(updated.code, 0, updated.output);
    assert.match(updated.output, /Updated dev@deployx\.local \(USER/);
    assert.equal((await login('dev@deployx.local', 'the new dev password')).status, 200);

    const weak = await runCli(['--email', uniqueEmail('cli')], { password: 'short' });
    assert.equal(weak.code, 1);
    assert.match(weak.output, /at least 12 characters/);
  });
});
