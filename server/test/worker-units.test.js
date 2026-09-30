// Unit tests for the worker's deployment building blocks. No network, Docker
// or database needed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deployx-unit-'));
process.env.WORKSPACE_ROOT = workspaceRoot;

const { childEnv, runCommand } = await import('../../worker/src/lib/exec.js');
const { createBuildLogCollector, sanitizeLine } = await import('../../worker/src/lib/buildLog.js');
const { createWorkspace, removeWorkspace, resolveInside, validateDockerfile, DockerfileNotFoundError } =
  await import('../../worker/src/services/workspace.js');
const { buildCloneArgs, GitSourceError } = await import('../../worker/src/services/gitService.js');
const { containerName, deploymentImageTag, firstPublishedHostPort, imageName, imageRepository, publishedHostPort } =
  await import('../../worker/src/services/dockerService.js');

const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DEPLOYMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

describe('image and container naming', () => {
  test('image names are sanitized and tagged with the commit SHA', () => {
    const sha = 'abc123def4567890abc123def4567890abc123de';
    assert.equal(imageName({ id: PROJECT_ID, name: 'My API' }, sha), 'deployx/my-api-0f8fad5b:abc123def456');
    assert.equal(imageRepository('  Hello__World!! v2 ', PROJECT_ID), 'deployx/hello-world-v2-0f8fad5b');
    assert.equal(imageRepository('ÄÖÜ ***', PROJECT_ID), 'deployx/project-0f8fad5b');
    assert.equal(imageRepository('x'.repeat(200), PROJECT_ID), `deployx/${'x'.repeat(40)}-0f8fad5b`);
    // Valid Docker reference: lower-case, no leading/trailing or doubled separators.
    assert.match(imageRepository('--Weird..Name--', PROJECT_ID), /^deployx\/[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test('container names contain both project and deployment IDs', () => {
    assert.equal(containerName(PROJECT_ID, DEPLOYMENT_ID), `deployx-${PROJECT_ID}-${DEPLOYMENT_ID}`);
  });

  test('every image also gets a tag of its own deployment, which a later build cannot move', () => {
    assert.equal(
      deploymentImageTag({ id: PROJECT_ID, name: 'My API' }, DEPLOYMENT_ID),
      `deployx/my-api-0f8fad5b:deployment-${DEPLOYMENT_ID}`,
    );
  });

  test('the published host port is read from the container, whatever its container port is', () => {
    const inspection = (ports) => ({ NetworkSettings: { Ports: ports } });
    const binding = [{ HostIp: '127.0.0.1', HostPort: '32771' }];
    assert.equal(publishedHostPort(inspection({ '3000/tcp': binding }), 3000), 32771);
    assert.equal(publishedHostPort(inspection({ '3000/tcp': binding }), 8080), null);
    assert.equal(firstPublishedHostPort(inspection({ '3000/tcp': binding })), 32771);
    assert.equal(firstPublishedHostPort(inspection({ '9000/tcp': null, '3000/tcp': binding })), 32771);
    assert.equal(firstPublishedHostPort(inspection({ '3000/tcp': null })), null);
    assert.equal(firstPublishedHostPort(null), null);
  });
});

describe('workspace isolation', () => {
  test('paths cannot escape their base directory', () => {
    const base = path.join(workspaceRoot, 'base');
    assert.equal(resolveInside(base, 'docker/Dockerfile'), path.join(base, 'docker', 'Dockerfile'));
    for (const bad of ['../outside', 'a/../../b', '/etc/passwd', '', 'C:\\Windows']) {
      if (bad === 'C:\\Windows' && process.platform !== 'win32') continue;
      assert.throws(() => resolveInside(base, bad), /Invalid path/, `"${bad}" should be rejected`);
    }
  });

  test('each deployment gets its own clean workspace, removed afterwards', async () => {
    const first = await createWorkspace(DEPLOYMENT_ID);
    assert.equal(first.dir, path.join(workspaceRoot, DEPLOYMENT_ID));
    await fs.mkdir(first.sourceDir, { recursive: true });
    await fs.writeFile(path.join(first.sourceDir, 'leftover.txt'), 'from attempt 1');

    // A retry of the same deployment starts from an empty directory.
    const retry = await createWorkspace(DEPLOYMENT_ID);
    assert.deepEqual(await fs.readdir(retry.dir), []);

    await removeWorkspace(retry);
    await assert.rejects(fs.stat(retry.dir), { code: 'ENOENT' });
  });

  test('workspace names must be deployment UUIDs', async () => {
    await assert.rejects(createWorkspace('../../etc'), /Invalid deployment ID/);
    await assert.rejects(createWorkspace('not-a-uuid'), /Invalid deployment ID/);
  });
});

describe('Dockerfile validation', () => {
  let sourceDir;
  before(async () => {
    sourceDir = path.join(workspaceRoot, 'dockerfile-src');
    await fs.mkdir(path.join(sourceDir, 'docker', 'dir-not-file'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'Dockerfile'), 'FROM scratch\n');
    await fs.writeFile(path.join(sourceDir, 'docker', 'Dockerfile'), 'FROM scratch\n');
  });

  test('accepts Dockerfiles inside the repository', async () => {
    assert.equal(await validateDockerfile(sourceDir, 'Dockerfile'), path.join(sourceDir, 'Dockerfile'));
    assert.equal(await validateDockerfile(sourceDir, 'docker/Dockerfile'), path.join(sourceDir, 'docker', 'Dockerfile'));
  });

  test('reports a missing Dockerfile clearly', async () => {
    await assert.rejects(validateDockerfile(sourceDir, 'missing/Dockerfile'), {
      name: 'Error',
      message: 'Dockerfile not found at missing/Dockerfile',
    });
    await assert.rejects(validateDockerfile(sourceDir, 'missing/Dockerfile'), DockerfileNotFoundError);
    await assert.rejects(validateDockerfile(sourceDir, 'docker/dir-not-file'), /is not a regular file/);
    await assert.rejects(validateDockerfile(sourceDir, '../Dockerfile'), /Invalid path/);
  });

  test('refuses a Dockerfile that is a symlink', async (t) => {
    const outside = path.join(workspaceRoot, 'secret.txt');
    await fs.writeFile(outside, 'host secret');
    try {
      await fs.symlink(outside, path.join(sourceDir, 'Linked.Dockerfile'));
    } catch (err) {
      // Creating symlinks needs extra privileges on Windows.
      t.skip(`cannot create symlinks here (${err.code})`);
      return;
    }
    await assert.rejects(validateDockerfile(sourceDir, 'Linked.Dockerfile'), /symbolic link/);
  });
});

describe('running commands', () => {
  test('arguments are never interpreted by a shell', async () => {
    const hostile = '$(echo pwned); echo pwned && rm -rf / `whoami` | cat';
    const { code, stdout } = await runCommand(process.execPath, ['-e', 'console.log(process.argv[1])', hostile]);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), hostile);
  });

  test('child processes do not inherit DeployX secrets', async () => {
    process.env.DATABASE_URL = 'postgresql://user:secret@db/deployx';
    process.env.REDIS_URL = 'redis://:secret@redis:6379';
    process.env.SOME_API_TOKEN = 'secret-token';
    try {
      const env = childEnv({ EXTRA: '1' });
      assert.equal(env.DATABASE_URL, undefined);
      assert.equal(env.REDIS_URL, undefined);
      assert.equal(env.SOME_API_TOKEN, undefined);
      assert.equal(env.EXTRA, '1');
      assert.ok(env.PATH || env.Path, 'PATH is kept');

      const { stdout } = await runCommand(process.execPath, [
        '-e',
        'console.log(JSON.stringify([process.env.DATABASE_URL, process.env.REDIS_URL, process.env.SOME_API_TOKEN]))',
      ]);
      assert.equal(stdout.trim(), '[null,null,null]');
    } finally {
      delete process.env.SOME_API_TOKEN;
    }
  });

  test('output is streamed line by line and slow commands are killed', async () => {
    const lines = [];
    const result = await runCommand(process.execPath, ['-e', 'console.log("one\\ntwo"); console.error("three")'], {
      onLine: (line, stream) => lines.push(`${stream}:${line}`),
    });
    assert.equal(result.code, 0);
    assert.deepEqual(lines.sort(), ['stderr:three', 'stdout:one', 'stdout:two']);

    await assert.rejects(runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 }), {
      name: 'CommandError',
      timedOut: true,
    });
  });
});

describe('git clone arguments', () => {
  test('only public GitHub https URLs and valid branches are accepted', () => {
    const args = buildCloneArgs({ repoUrl: 'https://github.com/example/app', branch: 'main', sourceDir: '/ws/source' });
    // Host credentials and non-https transports are switched off.
    assert.ok(args.includes('credential.helper='));
    assert.ok(args.includes('protocol.allow=never'));
    assert.ok(args.includes('core.symlinks=false'));
    // The URL comes after "--", so it can never be parsed as an option.
    assert.deepEqual(args.slice(-3), ['--', 'https://github.com/example/app', '/ws/source']);

    for (const repoUrl of [
      'https://gitlab.com/example/app',
      'file:///etc',
      'https://github.com/example/app;rm -rf /',
      'https://user:token@github.com/example/app',
      '--upload-pack=touch /tmp/pwned',
    ]) {
      assert.throws(() => buildCloneArgs({ repoUrl, branch: 'main', sourceDir: '/ws' }), GitSourceError, repoUrl);
    }
    for (const branch of ['--upload-pack=x', '../main', 'a b']) {
      assert.throws(() => buildCloneArgs({ repoUrl: 'https://github.com/a/b', branch, sourceDir: '/ws' }), GitSourceError);
    }
  });
});

describe('build log limits', () => {
  test('keeps build steps and errors, drops noise and duplicates', () => {
    const collector = createBuildLogCollector();
    const kept = [
      '#1 [internal] load build definition from Dockerfile',
      '#1 [internal] load build definition from Dockerfile',
      '#1 transferring dockerfile: 312B done',
      '#6 [2/3] RUN npm ci',
      '#6 0.512 added 120 packages in 3s',
      '#6 0.900 npm error code ERESOLVE',
      'Step 2/5 : COPY . .',
      '#9 naming to docker.io/deployx/app:abc done',
    ]
      .map((line) => collector.accept(line))
      .filter(Boolean);
    assert.deepEqual(kept, [
      '#1 [internal] load build definition from Dockerfile',
      '#6 [2/3] RUN npm ci',
      '#6 0.900 npm error code ERESOLVE',
      'Step 2/5 : COPY . .',
      '#9 naming to docker.io/deployx/app:abc done',
    ]);
  });

  test('caps the number and length of stored lines and keeps a tail', () => {
    const collector = createBuildLogCollector({ maxLines: 3, maxLineLength: 20, tailSize: 2 });
    const stored = [];
    for (let i = 1; i <= 10; i += 1) {
      const line = collector.accept(`#${i} [${i}/10] RUN step number ${i} with a long command`);
      if (line) stored.push(line);
    }
    assert.equal(stored.length, 3);
    assert.ok(stored.every((line) => line.endsWith('… [truncated]')));
    assert.equal(collector.dropped, 7);
    assert.equal(collector.tail().length, 2);
  });

  test('redacts credentials in URLs', () => {
    assert.equal(
      sanitizeLine('fetching https://bob:ghp_secret123@github.com/x/y.git', 200),
      'fetching https://***@github.com/x/y.git',
    );
  });
});
