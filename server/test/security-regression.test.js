// Security regression suite: one test per security boundary DeployX relies
// on. Each was established in an earlier phase (or Phase 8) and must never
// silently regress. Many are also covered in depth elsewhere; here they are
// checked together, end to end where possible.
//
//   [x] GitHub webhook cannot bypass signature validation
//   [x] User cannot access another user's project
//   [x] User cannot deploy another user's project
//   [x] Health check cannot reach a blocked private address
//   [x] AWS metadata endpoint remains blocked
//   [x] Docker command injection fails
//   [x] Repository URL injection fails
//   [x] Secrets do not appear in logs
//   [x] Invalid deployment state transitions remain blocked
//   [x] Passwords and sessions are never stored in plain text
//   [x] Operator endpoints are ADMIN only
//   [x] No secrets are committed; none reach the browser bundle
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, mock, test } from 'node:test';
import { WEBHOOK_SECRET, pushPayload, sign } from './githubWebhook.js';
import { TEST_PASSWORD, getDeploymentQueue, pool, projectPayload, setupTestServer } from './helpers.js';
import config from '../src/config/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let api;
let alice;
let mallory;
let aliceProject;
let health;
let git;
let docker;
let exec;
let buildLog;
let workerLogger;
const lines = [];

before(async () => {
  for (const method of ['log', 'warn', 'error']) mock.method(console, method, (...args) => lines.push(args.join(' ')));
  config.github.webhookSecret = WEBHOOK_SECRET;
  api = await setupTestServer();
  alice = await api.clientFor({ name: 'Alice', email: 'alice@example.com' });
  mallory = await api.clientFor({ name: 'Mallory', email: 'mallory@example.com' });
  aliceProject = (await alice.post('/api/projects', projectPayload({ github_repo: 'https://github.com/alice/shop' }))).body.data;
  health = await import('../../worker/src/services/healthCheckService.js');
  git = await import('../../worker/src/services/gitService.js');
  docker = await import('../../worker/src/services/dockerService.js');
  exec = await import('../../worker/src/lib/exec.js');
  buildLog = await import('../../worker/src/lib/buildLog.js');
  workerLogger = await import('../../worker/src/lib/logger.js');
});

after(async () => {
  await api.close();
  mock.restoreAll();
});

async function deploymentCount(projectId) {
  return (await pool.query('SELECT count(*)::int AS n FROM deployments WHERE project_id = $1', [projectId])).rows[0].n;
}

function deliver({ body, signature, event = 'push' }) {
  const headers = { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': 'regression-1' };
  if (signature !== undefined) headers['x-hub-signature-256'] = signature;
  return fetch(`${api.baseUrl}/api/webhooks/github`, { method: 'POST', headers, body });
}

describe('webhooks', () => {
  test('GitHub webhook cannot bypass signature validation', async () => {
    const body = JSON.stringify(pushPayload({ repo: aliceProject.github_repo }));
    const forged = [
      undefined, // no signature
      '',
      sign(body, 'not-the-secret'),
      sign(`${body} `), // signature of a different body
      sign(body).replace('sha256=', 'sha1='),
      sign(body).toUpperCase(),
      `${sign(body)}00`,
      'sha256=' + '0'.repeat(64),
    ];
    for (const signature of forged) {
      const response = await deliver({ body, signature });
      assert.equal(response.status, 401, `signature ${signature}`);
    }
    assert.equal(await deploymentCount(aliceProject.id), 0, 'nothing was deployed');

    // Without a configured secret nothing is accepted at all.
    config.github.webhookSecret = '';
    try {
      assert.equal((await deliver({ body, signature: sign(body, '') })).status, 503);
    } finally {
      config.github.webhookSecret = WEBHOOK_SECRET;
    }
    assert.equal((await deliver({ body, signature: sign(body) })).status, 202, 'the genuine delivery works');
  });
});

describe('authorization', () => {
  test("User cannot access another user's project", async () => {
    for (const [method, url, body] of [
      ['GET', `/api/projects/${aliceProject.id}`],
      ['PUT', `/api/projects/${aliceProject.id}`, { github_repo: 'https://github.com/mallory/backdoor' }],
      ['DELETE', `/api/projects/${aliceProject.id}`],
      ['GET', `/api/projects/${aliceProject.id}/deployments`],
    ]) {
      assert.equal((await mallory.request(method, url, body)).status, 403, `${method} ${url}`);
    }
    assert.ok(!(await mallory.get('/api/projects')).body.data.some((project) => project.id === aliceProject.id));
    assert.equal((await alice.get(`/api/projects/${aliceProject.id}`)).body.data.github_repo, 'https://github.com/alice/shop');
  });

  test("User cannot deploy another user's project", async () => {
    const before = await deploymentCount(aliceProject.id);
    const jobsBefore = await getDeploymentQueue().getJobCountByTypes('waiting', 'delayed', 'active');
    const response = await mallory.post(`/api/projects/${aliceProject.id}/deployments`, { branch: 'main' });
    assert.equal(response.status, 403);
    assert.equal(await deploymentCount(aliceProject.id), before);
    assert.equal(await getDeploymentQueue().getJobCountByTypes('waiting', 'delayed', 'active'), jobsBefore);

    const deployment = (await pool.query('SELECT id FROM deployments WHERE project_id = $1 LIMIT 1', [aliceProject.id])).rows[0];
    for (const url of [`/api/deployments/${deployment.id}`, `/api/deployments/${deployment.id}/logs`, `/api/deployments/${deployment.id}/logs/stream`]) {
      assert.equal((await mallory.get(url)).status, 403, url);
    }
  });

  test('Operator endpoints are ADMIN only', async () => {
    const deployment = (await pool.query('SELECT id FROM deployments WHERE project_id = $1 LIMIT 1', [aliceProject.id])).rows[0];
    assert.equal((await alice.patch(`/api/deployments/${deployment.id}/status`, { status: 'FAILED' })).status, 403);
    assert.equal((await alice.post(`/api/deployments/${deployment.id}/logs`, { level: 'ERROR', message: 'fake' })).status, 403);
  });
});

describe('server-side request forgery', () => {
  let requests = 0;
  let server;
  let port;

  before(async () => {
    server = http.createServer((req, res) => {
      requests += 1;
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  test('Health check cannot reach a blocked private address', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.10', '100.64.0.1', '::1', 'fd12::1', '0.0.0.0']) {
      const result = await health.checkServiceHealth({
        baseUrl: `http://app.example.com:${port}`,
        path: '/health',
        lookup: resolvesTo(address),
        allowPrivate: false,
      });
      assert.equal(result.healthy, false, address);
      assert.match(result.error, /resolves to|may not reach/, address);
    }
    // DNS rebinding: one public and one private answer is refused as a whole.
    const rebinding = await health.checkServiceHealth({
      baseUrl: `http://app.example.com:${port}`,
      path: '/health',
      lookup: resolvesTo('93.184.216.34', '127.0.0.1'),
      allowPrivate: false,
    });
    assert.equal(rebinding.healthy, false);
    assert.equal(requests, 0, 'no request was ever sent');

    // Local containers: only the configured host, never a user-chosen one.
    for (const host of ['169.254.169.254', '10.0.0.5', 'metadata.google.internal']) {
      const result = await health.checkContainerHealth({ host, port, path: '/health' });
      assert.match(result.error, /is not allowed/, host);
    }
    for (const path of ['//169.254.169.254/latest', '@169.254.169.254/', 'http://169.254.169.254/', '/health#@evil']) {
      const result = await health.checkContainerHealth({ host: '127.0.0.1', port, path });
      assert.equal(result.healthy, false, path);
    }
    assert.equal(requests, 0);
  });

  test('AWS metadata endpoint remains blocked, even when private addresses are allowed', async () => {
    for (const address of ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', '::ffff:169.254.169.254', 'fe80::1']) {
      const result = await health.checkServiceHealth({
        baseUrl: 'http://metadata.example.com',
        path: '/latest/meta-data',
        lookup: resolvesTo(address),
        allowPrivate: true,
      });
      assert.equal(result.healthy, false, address);
      assert.match(result.error, /may not reach/, address);
    }
    for (const baseUrl of ['http://169.254.169.254', 'http://[fd00:ec2::254]']) {
      const result = await health.checkServiceHealth({ baseUrl, path: '/latest/meta-data', allowPrivate: true });
      assert.equal(result.healthy, false, baseUrl);
    }
    // And the API refuses such service URLs before anything is stored.
    const stored = await alice.put(`/api/projects/${aliceProject.id}`, {
      deployment_target: 'AWS_ECS',
      aws_ecs_service: 'shop',
      aws_service_url: 'http://169.254.169.254/latest/meta-data',
    });
    assert.equal(stored.status, 400);
  });
});

describe('command and URL injection', () => {
  test('Docker command injection fails: arguments are never interpreted by a shell', async () => {
    const hostile = ['; rm -rf / #', '$(id)', '`id`', '&& calc.exe', '| cat /etc/passwd', '--privileged', "' OR '1'='1", '\n echo pwned'];
    const { stdout, code } = await exec.runCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...hostile]);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), hostile, 'every argument arrives verbatim');

    // Names DeployX gives images and containers cannot carry options or shell syntax.
    const project = { id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: '--privileged; $(rm -rf /) `id` ../../etc' };
    assert.match(docker.imageName(project, 'a'.repeat(40)), /^deployx\/[a-z0-9-]+-0f8fad5b:a{12}$/);
    assert.match(docker.containerName(project.id, project.id), /^deployx-[0-9a-f-]+-[0-9a-f-]+$/);

    // Dockerfile paths cannot leave the repository, through the API or the worker.
    for (const dockerfile of ['../../etc/passwd', '/etc/passwd', 'a/../../b', '--file=/etc/shadow']) {
      const response = await alice.put(`/api/projects/${aliceProject.id}`, { dockerfile_path: dockerfile });
      assert.equal(response.status, 400, dockerfile);
    }
    const { resolveInside } = await import('../../worker/src/services/workspace.js');
    assert.throws(() => resolveInside('/workspace/source', '../../etc/passwd'));
    assert.throws(() => resolveInside('/workspace/source', '/etc/passwd'));

    // Ports are numbers; nothing else reaches `docker run`.
    assert.equal((await alice.put(`/api/projects/${aliceProject.id}`, { container_port: '3000:3000 -v /:/host' })).status, 400);
  });

  test('Repository URL injection fails', async () => {
    const hostile = [
      'https://github.com/a/b;rm -rf /',
      'https://github.com/a/b --upload-pack=touch /tmp/pwned',
      '--upload-pack=evil',
      'ext::sh -c touch% /tmp/pwned',
      'file:///etc/passwd',
      'git@github.com:a/b.git',
      'ssh://git@github.com/a/b',
      'https://user:token@github.com/a/b',
      'https://github.com.evil.com/a/b',
      'https://evil.com/github.com/a/b',
      'https://github.com/a/b/../../c',
      'https://github.com/a/b?x=1',
      'http://github.com/a/b',
      'https://github.com/a/$(id)',
    ];
    for (const url of hostile) {
      const created = await alice.post('/api/projects', projectPayload({ github_repo: url }));
      assert.equal(created.status, 400, url);
      assert.throws(() => git.buildCloneArgs({ repoUrl: url, branch: 'main', sourceDir: '/tmp/x' }), undefined, url);
    }
    for (const branch of ['--upload-pack=evil', '-c', 'main;id', 'a..b', 'main$(id)']) {
      assert.equal((await alice.post(`/api/projects/${aliceProject.id}/deployments`, { branch })).status, 400, branch);
      assert.throws(() => git.buildCloneArgs({ repoUrl: 'https://github.com/a/b', branch, sourceDir: '/tmp/x' }), undefined, branch);
    }
    // The URL always comes after "--" in the clone command.
    const args = git.buildCloneArgs({ repoUrl: 'https://github.com/a/b', branch: 'main', sourceDir: '/tmp/x' });
    assert.equal(args[args.indexOf('--') + 1], 'https://github.com/a/b');
  });
});

describe('secrets', () => {
  test('Secrets do not appear in logs', async () => {
    lines.length = 0;
    await api.anonymous.post('/api/auth/login', { email: 'alice@example.com', password: 'Alice-wrong-password-123' });
    await api.anonymous.post('/api/auth/login', { email: 'alice@example.com', password: TEST_PASSWORD });
    const body = JSON.stringify(pushPayload({ repo: aliceProject.github_repo }));
    await deliver({ body, signature: sign(body) });
    await deliver({ body, signature: sign(body, 'attacker-secret') });

    // What the worker logs about a clone or registry failure.
    const token = 'ghs_' + 'Z'.repeat(36);
    const awsKey = 'AKIA' + 'Q'.repeat(16);
    workerLogger.logger.error('clone_failed', {
      err: new Error(`fatal: unable to access 'https://x-access-token:${token}@github.com/a/b/'`),
      env: { GITHUB_APP_PRIVATE_KEY: 'pem', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI', AWS_ACCESS_KEY_ID: awsKey },
    });
    const sanitized = buildLog.sanitizeLine(`Cloning into... https://x-access-token:${token}@github.com/a/b`, 500);

    const output = lines.join('\n') + sanitized;
    for (const secret of [TEST_PASSWORD, 'Alice-wrong-password-123', WEBHOOK_SECRET, sign(body).slice(7), token, awsKey, 'wJalrXUtnFEMI']) {
      assert.ok(!output.includes(secret), `secret leaked: ${secret}`);
    }

    // Child processes (git, docker build) never inherit DeployX's secrets.
    const saved = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://u:p@db/x',
      REDIS_URL: 'redis://:p@r',
      GITHUB_APP_PRIVATE_KEY: 'pem',
      GITHUB_WEBHOOK_SECRET: 's',
      AWS_SECRET_ACCESS_KEY: 'k',
      AWS_ACCESS_KEY_ID: 'AKIA',
      METRICS_TOKEN: 't',
      SESSION_SECRET: 'x',
    });
    try {
      const env = exec.childEnv();
      for (const name of ['DATABASE_URL', 'REDIS_URL', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'METRICS_TOKEN', 'SESSION_SECRET']) {
        assert.ok(!(name in env), name);
      }
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  test('Passwords and sessions are never stored in plain text; the cookie is HttpOnly and SameSite', async () => {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE password_hash IS NOT NULL');
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$/);
      assert.ok(!row.password_hash.includes(TEST_PASSWORD));
    }
    const response = await fetch(`${api.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: TEST_PASSWORD }),
    });
    const cookie = response.headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const token = cookie.split(';')[0].split('=')[1];
    const stored = await pool.query('SELECT token_hash FROM sessions');
    assert.ok(stored.rows.every((row) => row.token_hash.length === 32 && !row.token_hash.toString('latin1').includes(token)));
    assert.ok(!JSON.stringify(await response.json()).includes(token));
  });

  test('No secrets are committed; none reach the browser bundle', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(!files.some((file) => /(^|\/)\.env(\.|$)/.test(file) && !/\.env(\.[a-z]+)?\.example$/.test(file) && !file.endsWith('docker-tests.env')));
    assert.ok(!files.some((file) => /\.(pem|key|p12|pfx)$/.test(file)));

    // Real-looking credentials: long private keys, AWS keys, GitHub tokens.
    // (The redaction tests use short, obviously fake values.)
    const FAKE = /AKIAABCDEFGHIJKLMNOP|AKIAIOSFODNN7EXAMPLE|abcdefghijklmnop/;
    const patterns = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{200,}?-----END/,
      /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{50,}/,
      /\bxox[abps]-[A-Za-z0-9-]{10,}/,
      /\bsk_live_[A-Za-z0-9]{10,}/,
    ];
    for (const file of files) {
      if (/\.(png|jpg|ico|svg|lock)$|package-lock\.json$/.test(file)) continue;
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const pattern of patterns) {
        const match = text.match(pattern);
        assert.ok(!match || FAKE.test(match[0]), `${file} contains what looks like a secret: ${match?.[0].slice(0, 20)}…`);
      }
    }

    // The dashboard never reads build-time variables (anything VITE_* is
    // public in the bundle), and .env.example defines none.
    const clientSources = files.filter((file) => file.startsWith('client/src/') || file === 'client/vite.config.js');
    for (const file of clientSources) {
      assert.ok(!/import\.meta\.env\.VITE_/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), file);
    }
    assert.ok(!/^VITE_/m.test(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')));
  });
});

describe('state machine', () => {
  test('Invalid deployment state transitions remain blocked, through the API and in SQL', async () => {
    const { deployment } = (await api.post(`/api/projects/${aliceProject.id}/deployments`, {})).body.data;
    for (const status of ['SUCCESS', 'HEALTH_CHECK', 'ROLLING_BACK', 'ROLLBACK_FAILED']) {
      const response = await api.patch(`/api/deployments/${deployment.id}/status`, { status });
      assert.equal(response.status, 409, `QUEUED -> ${status}`);
      assert.equal(response.body.error.code, 'INVALID_STATE_TRANSITION');
    }
    await assert.rejects(pool.query(`UPDATE deployments SET status = 'SUCCESS' WHERE id = $1`, [deployment.id]), { code: 'DX001' });
    assert.equal((await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'FAILED' })).status, 200);
    await assert.rejects(pool.query(`UPDATE deployments SET status = 'QUEUED' WHERE id = $1`, [deployment.id]), { code: 'DX001' });
    assert.equal((await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'SUCCESS' })).status, 409, 'FAILED is final');
  });
});
