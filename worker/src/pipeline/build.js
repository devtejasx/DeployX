import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { createBuildLogCollector } from '../lib/buildLog.js';
import { recordCommit, recordImage } from '../services/deploymentService.js';
import { buildImage, deploymentImageTag, deploymentLabels, imageId, imageName } from '../services/dockerService.js';
import { GitSourceError, cloneAndCheckout } from '../services/gitService.js';
import { createGitHubApp, repositoryOf } from '../services/githubAppService.js';
import { DockerfileNotFoundError, createWorkspace, removeWorkspace, validateDockerfile } from '../services/workspace.js';

// Errors that another attempt cannot fix are raised as UnrecoverableError,
// so BullMQ fails the job at once instead of retrying it. Anything else
// (network trouble, a failed build) is retried according to the queue's
// retry policy.
function unrecoverable(message) {
  return new UnrecoverableError(message);
}

// The BUILDING stage, the same for every deployment target:
//   workspace -> GitHub App token (private repositories) -> git clone ->
//   checkout of the exact commit -> Dockerfile check -> docker build
// Returns { image, commitSha, cleanUp }: the local image, tagged
// <prefix>/<project>-<id>:<commit-12> (and :deployment-<id>), the full SHA it
// was built from, and the function that removes the workspace (safe to call
// more than once; the caller calls it once the sources are no longer needed).
//
// `github` is the GitHub App service (replaced in tests).
export function createSourceBuild({ github = createGitHubApp() } = {}) {
  // A read-only token for the repository when the GitHub App is installed on
  // it; null for anonymous access (public repositories).
  async function repositoryToken(ctx, repoUrl) {
    if (!github.configured) return null;
    const { owner, name } = repositoryOf(repoUrl);
    const access = await github.repositoryToken(repoUrl);
    if (!access) {
      await ctx.log('INFO', `The DeployX GitHub App is not installed on ${owner}/${name}; cloning without authentication`);
      return null;
    }
    const expires = access.expiresAt ? `, expires ${access.expiresAt}` : '';
    await ctx.log('INFO', `Using a GitHub App token for ${owner}/${name} (read-only${expires})`);
    return access.token;
  }

  return async function buildFromSource(ctx) {
    const { deployment, project } = ctx;
    const workspace = await createWorkspace(deployment.id);
    let workspaceRemoved = false;

    async function cleanUp() {
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
      // --- Source ------------------------------------------------------------
      let commitSha;
      try {
        commitSha = await cloneAndCheckout({
          repoUrl: project.github_repo,
          branch: deployment.branch,
          commitSha: deployment.commit_sha,
          token: await repositoryToken(ctx, project.github_repo),
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
        extraTags: [deploymentImageTag(project, deployment.id)],
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
      // The ID is kept next to the tag: a rollback restarts exactly this image.
      await recordImage(deployment.id, image, await imageId(image));
      await ctx.log('INFO', `Docker image created: ${image}`);

      return { image, commitSha, cleanUp };
    } catch (err) {
      await cleanUp();
      throw err;
    }
  };
}
