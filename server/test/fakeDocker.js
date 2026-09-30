// Test doubles for health-check and rollback tests, so they need no Docker
// daemon, registry or GitHub:
//
//   createFakeDocker()          an in-memory stand-in for the worker's Docker
//                               service. Every "container" is a real HTTP
//                               server on 127.0.0.1, so the worker's real
//                               health checks run against it.
//   createFakeDeployPipeline()  a pipeline whose build and run steps use the
//                               fake Docker, and which then hands over to the
//                               worker's REAL release stage (health check,
//                               promotion, rollback).
//
// How a deployed version behaves is chosen by its commit SHA:
//   docker.setApp('bad0001', () => 500)
// The app function gets the request path and the number of requests this
// container has received, and returns a status code, or 'hang' to never
// answer. It may be async. Versions without an app answer 200.
import crypto from 'node:crypto';
import http from 'node:http';

const HEALTHY = () => 200;

export function createFakeDocker() {
  const apps = new Map(); // commit -> app function
  const images = new Set(); // images that "exist on the Docker host"
  const containers = new Map(); // container ID -> container

  function find(nameOrId) {
    return containers.get(nameOrId) ?? [...containers.values()].find((container) => container.name === nameOrId) ?? null;
  }

  async function stopServer(container) {
    if (!container.running) return;
    container.running = false;
    container.server.closeAllConnections();
    await new Promise((resolve) => container.server.close(resolve));
  }

  return {
    // ---- the part of worker/src/services/dockerService.js the release uses ----
    async ensureAppNetwork() {},

    async imageExists(image) {
      return images.has(image);
    },

    async runContainer({ image, name, containerPort, labels }) {
      if (!images.has(image)) throw new Error(`docker run failed: Unable to find image '${image}' locally`);
      if (find(name)) throw new Error(`docker run failed: Conflict. The container name "/${name}" is already in use`);

      const commit = image.split(':').at(-1);
      const container = {
        id: crypto.randomBytes(32).toString('hex'),
        name,
        image,
        containerPort,
        labels,
        running: true,
        requests: [],
      };
      container.server = http.createServer(async (req, res) => {
        container.requests.push(req.url);
        const status = await (apps.get(commit) ?? HEALTHY)(req.url, container.requests.length);
        if (status === 'hang' || res.destroyed) return;
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end(`${image}\n`);
      });
      await new Promise((resolve) => container.server.listen(0, '127.0.0.1', resolve));
      container.hostPort = container.server.address().port;
      containers.set(container.id, container);
      return container.id;
    },

    async inspectContainer(nameOrId) {
      const container = find(nameOrId);
      if (!container) return null;
      return {
        Id: container.id,
        Name: `/${container.name}`,
        State: { Running: container.running, ExitCode: container.running ? 0 : 1 },
        NetworkSettings: {
          Ports: {
            [`${container.containerPort}/tcp`]: container.running
              ? [{ HostIp: '127.0.0.1', HostPort: String(container.hostPort) }]
              : null,
          },
        },
      };
    },

    async containerLogs(nameOrId) {
      const container = find(nameOrId);
      return container ? [`${container.image} listening on port ${container.containerPort}`] : [];
    },

    async removeContainer(nameOrId) {
      const container = find(nameOrId);
      if (!container) throw new Error(`Removing container ${nameOrId} failed: No such container`);
      await stopServer(container);
      containers.delete(container.id);
    },

    async listProjectContainers(projectId) {
      return [...containers.values()]
        .filter((container) => container.labels.includes(`deployx.project=${projectId}`))
        .map((container) => ({
          id: container.id,
          name: container.name,
          deploymentId: container.labels.find((label) => label.startsWith('deployx.deployment=')).split('=')[1],
        }));
    },

    // ---- controls for tests ----
    setApp(commit, app) {
      apps.set(commit, app);
    },
    // "docker build": the image now exists.
    addImage(image) {
      images.add(image);
    },
    // "docker rmi".
    removeImage(image) {
      images.delete(image);
    },
    container: find,
    // A container that died: it still exists, but no longer runs.
    async crash(nameOrId) {
      await stopServer(find(nameOrId));
    },
    async removeAll() {
      for (const container of containers.values()) await stopServer(container);
      containers.clear();
    },
  };
}

// fake/<project-id-prefix>:<commit>
export function fakeImageName(project, commitSha) {
  return `fake/${project.id.slice(0, 8)}:${commitSha}`;
}

export async function createFakeDeployPipeline({ docker }) {
  // Imported here, after the test set up its environment.
  const { createRelease } = await import('../../worker/src/pipeline/release.js');
  const { containerName, deploymentLabels, publishedHostPort } = await import('../../worker/src/services/dockerService.js');
  const { recordContainer, recordImage } = await import('../../worker/src/services/deploymentService.js');
  const release = createRelease({ docker });

  return async function fakeDeployPipeline(ctx) {
    const { deployment, project } = ctx;

    await ctx.setStage('BUILDING', 'Deployment is now building');
    const image = fakeImageName(project, deployment.commit_sha);
    docker.addImage(image);
    await recordImage(deployment.id, image);
    await ctx.log('INFO', `Docker image created: ${image}`);

    await ctx.setStage('DEPLOYING', 'Deployment is now deploying');
    const name = containerName(project.id, deployment.id);
    // A container of an earlier attempt of this same deployment (as the real pipeline does).
    if (await docker.inspectContainer(name)) await docker.removeContainer(name);
    const containerId = await docker.runContainer({
      image,
      name,
      containerPort: project.container_port,
      labels: deploymentLabels({ projectId: project.id, deploymentId: deployment.id }),
    });
    const hostPort = publishedHostPort(await docker.inspectContainer(containerId), project.container_port);
    await recordContainer(deployment.id, { containerId, containerName: name, hostPort });
    await ctx.log('INFO', `Container started: ${name}`);

    // From here on it is the worker's real code.
    return release(ctx, { containerId, name, hostPort, image });
  };
}
