import crypto from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';

// Authenticated access to private repositories through a GitHub App.
//
//   App private key ──RS256──> JWT (10 min, identifies the App)
//     ──> GET  /repos/{owner}/{repo}/installation         is the App installed there?
//     ──> POST /app/installations/{id}/access_tokens      token for THIS repository only,
//                                                          contents: read, expires in 1 hour
//
// The token is created by the worker for one deployment and handed to git in
// its environment (gitService.js); it is never stored, logged or sent to the
// API or the browser. No user tokens are involved.

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10000;
const REPO_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

// A GitHub API request that failed in a way another attempt may not (network
// trouble, rate limits, GitHub errors). Failures that retrying cannot fix,
// such as wrong App credentials, are raised as UnrecoverableError instead.
export class GitHubAppError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'GitHubAppError';
    this.status = status;
  }
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

// The App's JWT: issued a minute in the past (clock drift), valid 9 minutes
// (GitHub allows at most 10).
export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(appId) }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

// { owner, name } of a canonical https://github.com/<owner>/<repo> URL.
export function repositoryOf(repoUrl) {
  const match = REPO_URL_PATTERN.exec(repoUrl ?? '');
  if (!match) throw new UnrecoverableError(`Unsupported repository URL: ${repoUrl}`);
  return { owner: match[1], name: match[2] };
}

export function createGitHubApp({
  appId = config.github.appId,
  privateKey = config.github.privateKey,
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  const configured = Boolean(appId && privateKey);

  async function request(method, path, { token, body } = {}) {
    let response;
    try {
      response = await fetch(`${GITHUB_API}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'DeployX',
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GitHubAppError(`GitHub API request failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  }

  function failure(what, { status, data }) {
    const reason = typeof data?.message === 'string' ? data.message.slice(0, 200) : `HTTP ${status}`;
    const message = `GitHub API: ${what} failed (${status}: ${reason})`;
    // Bad App ID or private key: another attempt fails the same way.
    return status === 401 ? new UnrecoverableError(`${message}; check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY`) : new GitHubAppError(message, { status });
  }

  return {
    configured,

    // A token to clone `repoUrl`, or null when no App is configured or it is
    // not installed on that repository (the clone is then anonymous, which
    // works for public repositories):
    //   { token, expiresAt, installationId }
    async repositoryToken(repoUrl) {
      if (!configured) return null;
      const { owner, name } = repositoryOf(repoUrl);
      let jwt;
      try {
        jwt = createAppJwt({ appId, privateKey, now: now() });
      } catch {
        throw new UnrecoverableError('GITHUB_APP_PRIVATE_KEY is not a valid RSA private key (PEM)');
      }

      const installation = await request('GET', `/repos/${owner}/${name}/installation`, { token: jwt });
      if (installation.status === 404) return null;
      if (installation.status !== 200 || !Number.isInteger(installation.data?.id)) {
        throw failure(`looking up the App installation for ${owner}/${name}`, installation);
      }

      const access = await request('POST', `/app/installations/${installation.data.id}/access_tokens`, {
        token: jwt,
        body: { repositories: [name], permissions: { contents: 'read' } },
      });
      if (access.status !== 201 || typeof access.data?.token !== 'string') {
        throw failure(`creating a token for ${owner}/${name}`, access);
      }
      return { token: access.data.token, expiresAt: access.data.expires_at ?? null, installationId: installation.data.id };
    },
  };
}
