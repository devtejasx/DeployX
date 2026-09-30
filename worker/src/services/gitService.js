import path from 'node:path';
import config from '../config/index.js';
import { childEnv, runCommand } from '../lib/exec.js';

// Same rule as the API's validator: https://github.com/<owner>/<repo> only.
// Re-checked here because the worker must not trust what it reads from the
// database more than the API trusted the request.
const GITHUB_REPO_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![/.])$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

// A failure that retrying cannot fix (missing repository, branch or commit).
export class GitSourceError extends Error {}

// Options applied to every git command:
// - no credential helpers: the host's stored credentials are never offered to
//   GitHub (private repositories use a GitHub App token, see gitEnv)
// - only https is allowed as a transport (no file://, ssh://, ext::)
// - symlinks are checked out as plain files, so the repository cannot point
//   the build at files outside the workspace
const GIT_CONFIG_ARGS = [
  '-c', 'credential.helper=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'core.symlinks=false',
  '-c', 'core.autocrlf=false',
  '-c', 'advice.detachedHead=false',
];

// With a `token` (a GitHub App installation token for the repository), git
// sends it as an Authorization header to https://github.com/ only. It is
// passed through the environment (GIT_CONFIG_COUNT/KEY/VALUE): not in the
// command line, which other processes can read, not in the remote URL or
// .git/config, and not in any output git prints.
export function gitEnv(workspaceDir, token = null) {
  const auth = token
    ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      }
    : {};
  return childEnv({
    // Fail instead of waiting for a username/password prompt (private or
    // non-existent repositories).
    GIT_TERMINAL_PROMPT: '0',
    // Ignore the machine's system and user git configuration (credential
    // helpers, URL rewrites, hooks).
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(workspaceDir, 'no-global-gitconfig'),
    ...auth,
  });
}

export function buildCloneArgs({ repoUrl, branch, sourceDir }) {
  if (!GITHUB_REPO_PATTERN.test(repoUrl)) throw new GitSourceError(`Unsupported repository URL: ${repoUrl}`);
  if (!BRANCH_PATTERN.test(branch)) throw new GitSourceError(`Invalid branch name: ${branch}`);
  return [
    ...GIT_CONFIG_ARGS,
    'clone',
    '--single-branch',
    '--branch', branch,
    // Commits and trees now, file contents only for the commit checked out.
    '--filter=blob:none',
    '--no-checkout',
    '--',
    repoUrl,
    sourceDir,
  ];
}

function git(args, { workspaceDir, cwd, token, timeoutMs = config.git.timeoutMs } = {}) {
  return runCommand('git', args, { cwd, env: gitEnv(workspaceDir, token), timeoutMs });
}

function describeCloneFailure(tail, { repoUrl, branch, authenticated }) {
  const output = tail.join('\n');
  if (/Remote branch .* not found/i.test(output)) {
    return new GitSourceError(`Branch "${branch}" not found in ${repoUrl}`);
  }
  if (/Repository not found|could not read Username|terminal prompts disabled|Authentication failed/i.test(output)) {
    return new GitSourceError(
      authenticated
        ? `Repository ${repoUrl} not found, or the DeployX GitHub App has no access to it`
        : `Repository ${repoUrl} not found or not public (for a private repository, install the DeployX GitHub App on it)`,
    );
  }
  // Anything else (DNS, TLS, timeouts, GitHub hiccups) may be transient.
  return new Error(`git clone failed: ${tail.at(-1) ?? 'unknown error'}`);
}

// Clones `branch` of `repoUrl` into `sourceDir` and checks out `commitSha`
// (or the branch head when no commit was requested). Returns the full SHA
// that was actually checked out, so the build is tied to an exact commit.
// `token` authenticates every git command of the clone (private repositories).
export async function cloneAndCheckout({ repoUrl, branch, commitSha, token = null, workspaceDir, sourceDir, onStep }) {
  onStep?.(`Cloning repository ${repoUrl} (branch ${branch})`);
  const clone = await git(buildCloneArgs({ repoUrl, branch, sourceDir }), { workspaceDir, token });
  if (clone.code !== 0) throw describeCloneFailure(clone.tail, { repoUrl, branch, authenticated: Boolean(token) });

  const target = commitSha ?? 'HEAD';
  if (commitSha !== null && commitSha !== undefined && !SHA_PATTERN.test(commitSha)) {
    throw new GitSourceError(`Invalid commit SHA: ${commitSha}`);
  }

  // Resolves abbreviated SHAs; fails for commits that are not on the branch.
  const resolve = await git([...GIT_CONFIG_ARGS, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${target}^{commit}`], {
    workspaceDir,
    cwd: sourceDir,
    token,
  });
  const fullSha = resolve.stdout.trim();
  if (resolve.code !== 0 || !/^[0-9a-f]{40}$/.test(fullSha)) {
    throw new GitSourceError(`Commit ${commitSha} not found on branch ${branch}`);
  }

  onStep?.(`Checking out commit ${fullSha}`);
  // The file contents of a partial clone are downloaded here: this needs the
  // token as well.
  const checkout = await git([...GIT_CONFIG_ARGS, 'checkout', '--detach', '--quiet', fullSha, '--'], {
    workspaceDir,
    cwd: sourceDir,
    token,
  });
  if (checkout.code !== 0) {
    throw new Error(`git checkout failed: ${checkout.tail.at(-1) ?? 'unknown error'}`);
  }

  // Belt and braces: the working tree must be exactly the requested commit.
  const head = await git([...GIT_CONFIG_ARGS, 'rev-parse', 'HEAD'], { workspaceDir, cwd: sourceDir });
  if (head.stdout.trim() !== fullSha) {
    throw new Error(`Checked-out commit ${head.stdout.trim()} does not match ${fullSha}`);
  }

  return fullSha;
}
