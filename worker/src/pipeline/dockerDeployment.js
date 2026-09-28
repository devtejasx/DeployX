import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { createBuildLogCollector } from '../lib/buildLog.js';
import {
  buildImage,
  containerLogs,
  containerName,
  deploymentLabels,
  ensureAppNetwork,
  imageName,
  inspectContainer,
  listProjectContainers,
  publishedHostPort,
  removeContainer,
  runContainer,
} from '../services/dockerService.js';
import {
  recordCommit,
  recordContainer,
  recordContainerRemoved,
  recordImage,
} from '../services/deploymentService.js';
import { GitSourceError, cloneAndCheckout } from '../services/gitService.js';
import { DockerfileNotFoundError, createWorkspace, removeWorkspace, validateDockerfile } from '../services/workspace.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Errors that another attempt cannot fix are raised as UnrecoverableError,
// so BullMQ fails the job at once instead of retrying it. Anything else
// (network trouble, a failed build, a crashing container) is retried
// according to the queue's retry policy.
function unrecoverable(message) {
  return new UnrecoverableError(message);
}

// The real deployment pipeline:
//   BUILDING:  workspace -> git clone -> checkout commit -> Dockerfile check -> docker build
//   DEPLOYING: docker run -> verify running -> replace previous container
//   SUCCESS
// The workspace is removed at the end whatever happens.
export async function runDockerDeployment(ctx) {
  const { deployment, project } = ctx;

  if (!project.container_port) {
    throw unrecoverable('Project has no container_port configured; set it with PUT /api/projects/:id');
  }

  const workspace = await createWorkspace(deployment.id);
  let workspaceRemoved = false;

  async function cleanUpWorkspace() {
    if (workspaceRemoved) return;
    workspaceRemoved = true;
    try {
      await removeWorkspace(workspace);
      await ctx.log('INFO', 'Cleanup completed: workspace removed');
    } catch (err) {
      // Never hide the deployment result behind a cleanup problem.
      await ctx.log('WARN', `Workspace cleanup failed: ${err.message}`);
    }
  }

  try {
    await ctx.setStage('BUILDING', 'Deployment is now building');

    // --- Source ------------------------------------------------------------
    let commitSha;
    try {
      commitSha = await cloneAndCheckout({
        repoUrl: project.github_repo,
        branch: deployment.branch,
        commitSha: deployment.commit_sha,
        workspaceDir: workspace.dir,
        sourceDir: workspace.sourceDir,
        onStep: (message) => ctx.log('INFO', message),
      });
    } catch (err) {
      if (err instanceof GitSourceError) throw unrecoverable(err.message);
      throw err;
    }
    await recordCommit(deployment.id, commitSha);

    let dockerfile;
    try {
      dockerfile = await validateDockerfile(workspace.sourceDir, project.dockerfile_path);
    } catch (err) {
      if (err instanceof DockerfileNotFoundError || /Invalid path/.test(err.message)) throw unrecoverable(err.message);
      throw err;
    }
    await ctx.log('INFO', `Dockerfile found at ${project.dockerfile_path}`);

    // --- Build -------------------------------------------------------------
    const image = imageName(project, commitSha);
    const labels = deploymentLabels({ projectId: project.id, deploymentId: deployment.id });
    await ctx.log('INFO', `Starting Docker build of ${image}`);

    const buildLog = createBuildLogCollector({ maxLines: config.docker.buildLogMaxLines });
    const storedLines = new Set();
    // Build output arrives faster than it can be stored; keep the order by
    // chaining the inserts and wait for them after the build.
    let pendingLogs = Promise.resolve();
    const build = await buildImage({
      contextDir: workspace.sourceDir,
      dockerfile,
      image,
      labels,
      onLine: (line) => {
        const stored = buildLog.accept(line);
        if (stored) {
          storedLines.add(stored);
          pendingLogs = pendingLogs.then(() => ctx.log('INFO', stored));
        }
      },
    });
    await pendingLogs;
    if (buildLog.dropped > 0) {
      await ctx.log('WARN', `${buildLog.dropped} further build output lines were not stored (limit reached)`);
    }
    if (build.code !== 0) {
      // Make sure the lines explaining the failure are stored.
      for (const line of buildLog.tail()) {
        if (!storedLines.has(line)) await ctx.log('ERROR', line);
      }
      const reason = buildLog.tail().findLast((line) => /error/i.test(line)) ?? `exit code ${build.code}`;
      throw new Error(`Docker build failed: ${reason}`);
    }
    await recordImage(deployment.id, image);
    await ctx.log('INFO', `Docker image created: ${image}`);

    // --- Run ---------------------------------------------------------------
    await ctx.setStage('DEPLOYING', 'Deployment is now deploying');
    await ensureAppNetwork();

    const name = containerName(project.id, deployment.id);
    // A container of an earlier attempt of this same deployment.
    if (await inspectContainer(name)) {
      await removeContainer(name);
      await ctx.log('INFO', `Removed container ${name} left by an earlier attempt`);
    }

    await ctx.log('INFO', `Starting container ${name}`);
    const containerId = await runContainer({ image, name, containerPort: project.container_port, labels });

    // Not a health check (Phase 6): only make sure it did not exit at once.
    await sleep(config.docker.startupGraceMs);
    const state = await inspectContainer(containerId);
    if (!state?.State?.Running) {
      const exitCode = state?.State?.ExitCode;
      const output = await containerLogs(containerId).catch(() => []);
      for (const line of output) await ctx.log('ERROR', `[container] ${line.slice(0, 1000)}`);
      await removeContainer(containerId).catch(() => {});
      await ctx.log('INFO', `Removed failed container ${name}`);
      throw new Error(`Container exited immediately (exit code ${exitCode ?? 'unknown'})`);
    }

    const hostPort = publishedHostPort(state, project.container_port);
    await recordContainer(deployment.id, { containerId, containerName: name, hostPort });
    await ctx.log(
      'INFO',
      `Container started: ${name} (${containerId.slice(0, 12)}); port ${project.container_port} published on ` +
        `127.0.0.1:${hostPort}`,
    );

    // One active deployment per project: stop the previous container(s) only
    // now that the new one is running. Deployment history stays in the database.
    for (const previous of await listProjectContainers(project.id)) {
      if (previous.id === containerId) continue;
      await removeContainer(previous.id);
      if (previous.deploymentId) {
        await recordContainerRemoved(previous.deploymentId, `Container removed: replaced by deployment ${deployment.id}`);
      }
      await ctx.log('INFO', `Stopped previous container ${previous.name}`);
    }

    await cleanUpWorkspace();
    await ctx.setStage('SUCCESS', 'Deployment completed successfully');
    return { status: 'SUCCESS', image, containerId, hostPort };
  } finally {
    await cleanUpWorkspace();
  }
}
