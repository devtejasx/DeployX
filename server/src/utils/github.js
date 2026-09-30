// https://github.com/<owner>/<repo>, optionally ending in .git or /.
// The worker re-checks the canonical form (worker/src/services/gitService.js).
const GITHUB_REPO_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

// { owner, name, url } of a GitHub repository URL, with `url` in the canonical
// form DeployX stores (https://github.com/<owner>/<repo>), or null when it is
// not a github.com repository URL.
export function parseGitHubRepo(url) {
  const match = typeof url === 'string' ? url.match(GITHUB_REPO_PATTERN) : null;
  if (!match) return null;
  const [, owner, name] = match;
  if (name === '.' || name === '..') return null;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}
