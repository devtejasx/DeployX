import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../config/index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Joins `relativePath` onto `baseDir` and guarantees the result stays inside
// it: absolute paths and ".." segments are rejected even though the API
// already validates them (defence in depth).
export function resolveInside(baseDir, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid path "${relativePath}": must be relative`);
  }
  if (relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid path "${relativePath}": ".." is not allowed`);
  }
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Invalid path "${relativePath}": escapes ${base}`);
  }
  return resolved;
}

// Creates an empty, private workspace for one deployment:
//   <WORKSPACE_ROOT>/<deployment-id>/source   - the cloned repository
// Leftovers from an earlier attempt of the same deployment are removed first,
// so every attempt starts clean and deployments never share files.
export async function createWorkspace(deploymentId) {
  if (!UUID_PATTERN.test(deploymentId)) {
    throw new Error(`Invalid deployment ID "${deploymentId}"`);
  }
  const dir = resolveInside(config.workspace.root, deploymentId);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return { dir, sourceDir: path.join(dir, 'source') };
}

export async function removeWorkspace(workspace) {
  await fs.rm(workspace.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

// Deletes workspaces left behind by a worker that was killed mid-job.
// Only directories older than `maxAgeMs` are touched, so workspaces of jobs
// running right now (e.g. in another local worker) are left alone.
export async function sweepStaleWorkspaces(maxAgeMs = config.workspace.staleAfterMs) {
  let entries;
  try {
    entries = await fs.readdir(config.workspace.root, { withFileTypes: true });
  } catch {
    return 0; // no workspace root yet
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    const dir = path.join(config.workspace.root, entry.name);
    const { mtimeMs } = await fs.stat(dir);
    if (Date.now() - mtimeMs > maxAgeMs) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    }
  }
  return removed;
}

export class DockerfileNotFoundError extends Error {}

// Checks that the configured Dockerfile exists inside the checked-out source
// as a regular file. Symlinks are refused: they could point outside the
// workspace and make `docker build` read a file from the worker's host.
export async function validateDockerfile(sourceDir, dockerfilePath) {
  const absolute = resolveInside(sourceDir, dockerfilePath);
  let stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new DockerfileNotFoundError(`Dockerfile not found at ${dockerfilePath}`);
    }
    throw err;
  }
  if (stats.isSymbolicLink()) {
    throw new DockerfileNotFoundError(`Dockerfile at ${dockerfilePath} is a symbolic link, which is not allowed`);
  }
  if (!stats.isFile()) {
    throw new DockerfileNotFoundError(`Dockerfile at ${dockerfilePath} is not a regular file`);
  }
  const realSource = await fs.realpath(sourceDir);
  const realDockerfile = await fs.realpath(absolute);
  if (!realDockerfile.startsWith(realSource + path.sep)) {
    throw new DockerfileNotFoundError(`Dockerfile at ${dockerfilePath} resolves outside the repository`);
  }
  return absolute;
}
