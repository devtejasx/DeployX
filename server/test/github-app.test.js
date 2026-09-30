// GitHub App authentication for private repositories, and how the token
// reaches git. The GitHub API is replaced by a fake `fetch`; git itself is
// the real one (no network needed).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployx-github-app-'));
process.env.WORKSPACE_ROOT = workspaceRoot;

const { GitHubAppError, createAppJwt, createGitHubApp, repositoryOf } = await import(
  '../../worker/src/services/githubAppService.js'
);
const { buildCloneArgs, gitEnv } = await import('../../worker/src/services/gitService.js');
const { runCommand } = await import('../../worker/src/lib/exec.js');

after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
const REPO = 'https://github.com/octo-org/private-app';
const TOKEN = 'fake-installation-token-for-tests-only';
const NOW = Date.parse('2026-09-30T12:00:00Z');

// A fake GitHub API: `routes` maps "METHOD /path" to { status, body }.
function fakeFetch(routes) {
  const requests = [];
  async function fetch(url, init) {
    const route = `${init.method} ${new URL(url).pathname}`;
    requests.push({ route, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = routes[route];
    if (answer instanceof Error) throw answer;
    if (!answer) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }
  return { fetch, requests };
}

const INSTALLED = {
  'GET /repos/octo-org/private-app/installation': { status: 200, body: { id: 4242, account: { login: 'octo-org' } } },
  'POST /app/installations/4242/access_tokens': {
    status: 201,
    body: { token: TOKEN, expires_at: '2026-09-30T13:00:00Z', permissions: { contents: 'read' } },
  },
};

function app(fetch, overrides = {}) {
  return createGitHubApp({ appId: '123456', privateKey: PRIVATE_KEY, fetch, now: () => NOW, ...overrides });
}

describe('GitHub App', () => {
  test('the App JWT is RS256-signed, issued a minute early and valid for less than ten minutes', () => {
    const jwt = createAppJwt({ appId: '123456', privateKey: PRIVATE_KEY, now: NOW });
    const [header, payload, signature] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.deepEqual(claims, { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '123456' });
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  });

  test('gets a read-only token for exactly the repository being deployed', async () => {
    const { fetch, requests } = fakeFetch(INSTALLED);
    const access = await app(fetch).repositoryToken(REPO);

    assert.deepEqual(access, { token: TOKEN, expiresAt: '2026-09-30T13:00:00Z', installationId: 4242 });
    assert.deepEqual(
      requests.map((request) => request.route),
      ['GET /repos/octo-org/private-app/installation', 'POST /app/installations/4242/access_tokens'],
    );
    assert.deepEqual(requests[1].body, { repositories: ['private-app'], permissions: { contents: 'read' } });
    for (const request of requests) {
      assert.match(request.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      assert.equal(request.headers['x-github-api-version'], '2022-11-28');
    }
  });

  test('no App configured, or not installed on the repository: anonymous clone', async () => {
    const unused = fakeFetch({});
    const notConfigured = createGitHubApp({ appId: '', privateKey: '', fetch: unused.fetch });
    assert.equal(notConfigured.configured, false);
    assert.equal(await notConfigured.repositoryToken(REPO), null);
    assert.equal(unused.requests.length, 0);

    const { fetch } = fakeFetch({});
    assert.equal(await app(fetch).repositoryToken(REPO), null);
  });

  test('GitHub API failures: retried when temporary, final when the App credentials are wrong', async () => {
    const outage = fakeFetch({
      'GET /repos/octo-org/private-app/installation': { status: 502, body: { message: 'Server Error' } },
    });
    await assert.rejects(app(outage.fetch).repositoryToken(REPO), (err) => {
      assert.ok(err instanceof GitHubAppError);
      assert.equal(err.message, 'GitHub API: looking up the App installation for octo-org/private-app failed (502: Server Error)');
      return true;
    });

    const network = fakeFetch({ 'GET /repos/octo-org/private-app/installation': new TypeError('fetch failed') });
    await assert.rejects(app(network.fetch).repositoryToken(REPO), { name: 'GitHubAppError', message: 'GitHub API request failed: fetch failed' });

    const badCredentials = fakeFetch({
      'GET /repos/octo-org/private-app/installation': { status: 401, body: { message: 'A JSON web token could not be decoded' } },
    });
    await assert.rejects(app(badCredentials.fetch).repositoryToken(REPO), {
      name: 'UnrecoverableError',
      message: /\(401: A JSON web token could not be decoded\); check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY$/,
    });

    const noToken = fakeFetch({
      ...INSTALLED,
      'POST /app/installations/4242/access_tokens': { status: 422, body: { message: 'There is at least one repository that does not exist' } },
    });
    await assert.rejects(app(noToken.fetch).repositoryToken(REPO), { name: 'GitHubAppError', message: /creating a token for octo-org\/private-app failed \(422/ });

    const { fetch } = fakeFetch(INSTALLED);
    await assert.rejects(app(fetch, { privateKey: 'not a key' }).repositoryToken(REPO), {
      name: 'UnrecoverableError',
      message: 'GITHUB_APP_PRIVATE_KEY is not a valid RSA private key (PEM)',
    });
  });

  test('only canonical github.com repository URLs are accepted', () => {
    assert.deepEqual(repositoryOf(REPO), { owner: 'octo-org', name: 'private-app' });
    for (const bad of ['https://github.com/octo-org/app.git/../x', 'https://gitlab.com/a/b', 'https://github.com/a', '']) {
      assert.throws(() => repositoryOf(bad), { name: 'UnrecoverableError' }, bad);
    }
  });
});

describe('private repository clones', () => {
  test('git receives the token as an Authorization header for github.com only, through its environment', async () => {
    const env = gitEnv(workspaceRoot, TOKEN);
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
    assert.equal(env.GIT_CONFIG_VALUE_0, header);

    // The real git picks it up for github.com...
    const forGitHub = await runCommand('git', ['config', '--get-urlmatch', 'http.extraHeader', `${REPO}/info/refs`], { env });
    assert.equal(forGitHub.stdout.trim(), header);
    // ...and for nothing else, e.g. a redirect or submodule to another host.
    const elsewhere = await runCommand('git', ['config', '--get-urlmatch', 'http.extraHeader', 'https://evil.example.com/repo'], { env });
    assert.equal(elsewhere.stdout.trim(), '');
  });

  test('without a token nothing is added, and the token never appears in git arguments', async () => {
    const env = gitEnv(workspaceRoot);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.ok(!Object.keys(env).some((name) => name.startsWith('GIT_CONFIG_KEY')));
    const plain = await runCommand('git', ['config', '--get-urlmatch', 'http.extraHeader', `${REPO}/info/refs`], { env });
    assert.equal(plain.stdout.trim(), '');

    const args = buildCloneArgs({ repoUrl: REPO, branch: 'main', sourceDir: path.join(workspaceRoot, 'src') });
    assert.ok(!args.join(' ').includes(TOKEN));
    assert.ok(args.includes('credential.helper='));
  });

  test('secrets reach a program through stdin, not its command line', async () => {
    const secret = 'ecr-password-in-stdin';
    const args = ['-e', 'process.stdin.pipe(process.stdout)'];
    const result = await runCommand(process.execPath, args, { input: secret });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, secret);
    assert.ok(!args.join(' ').includes(secret));

    // A program that ignores its input does not break the call.
    const ignored = await runCommand(process.execPath, ['-e', 'process.exit(0)'], { input: 'x'.repeat(1024 * 1024) });
    assert.equal(ignored.code, 0);
  });
});
