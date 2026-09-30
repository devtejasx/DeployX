import config from '../config/index.js';
import { childEnv, runCommand } from '../lib/exec.js';

// Labels on every image and container DeployX creates, so they can be found
// (and cleaned up) without relying on names alone.
const MANAGED_LABEL = 'deployx.managed=true';

// Linux capabilities deployed apps keep. Everything else (NET_RAW, MKNOD,
// SYS_CHROOT, SETFCAP, SETPCAP, AUDIT_WRITE, ...) is dropped. These cover
// ordinary web servers: binding ports < 1024 and dropping to a non-root user.
const APP_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETUID', 'SETGID', 'NET_BIND_SERVICE', 'KILL'];

function docker(args, options = {}) {
  return runCommand('docker', args, {
    env: childEnv({ DOCKER_BUILDKIT: '1' }),
    timeoutMs: config.docker.commandTimeoutMs,
    ...options,
  });
}

async function dockerOrThrow(args, what, options) {
  const result = await docker(args, options);
  if (result.code !== 0) {
    throw new Error(`${what} failed: ${result.tail.at(-1) ?? `exit code ${result.code}`}`);
  }
  return result;
}

// Project name -> valid Docker repository component: lower-case letters,
// digits and single dashes, at most 40 characters. The short project ID keeps
// two projects whose names sanitize the same ("My API", "my-api") apart.
export function imageRepository(projectName, projectId) {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'project';
  return `${config.docker.imagePrefix}/${slug}-${projectId.slice(0, 8)}`;
}

// deployx/<project-slug>-<project-id-prefix>:<first 12 characters of the commit SHA>
export function imageName(project, commitSha) {
  return `${imageRepository(project.name, project.id)}:${commitSha.slice(0, 12)}`;
}

// deployx/<project-slug>-<project-id-prefix>:deployment-<deployment-id>
// A second tag on every built image, unique to its deployment. The commit tag
// above moves when the same commit is built again; this one keeps the image
// of a deployment on the Docker host, so a rollback can start it again.
export function deploymentImageTag(project, deploymentId) {
  return `${imageRepository(project.name, project.id)}:deployment-${deploymentId}`;
}

// Unique per deployment; a project can have several deployments over time.
export function containerName(projectId, deploymentId) {
  return `deployx-${projectId}-${deploymentId}`;
}

export function deploymentLabels({ projectId, deploymentId }) {
  return [MANAGED_LABEL, `deployx.project=${projectId}`, `deployx.deployment=${deploymentId}`];
}

// Creates the network deployed apps run on, if it does not exist yet. It is a
// separate bridge network from DeployX's own services (PostgreSQL, Redis,
// API), and inter-container traffic on it is disabled, so apps cannot reach
// DeployX's services or each other.
export async function ensureAppNetwork(name = config.docker.appNetwork) {
  const inspect = await docker(['network', 'inspect', '--format', '{{.Name}}', name]);
  if (inspect.code === 0) return;

  const create = await docker([
    'network', 'create',
    '--driver', 'bridge',
    '--label', MANAGED_LABEL,
    '--opt', 'com.docker.network.bridge.enable_icc=false',
    name,
  ]);
  // Another job may have created it at the same moment.
  if (create.code !== 0 && !create.tail.some((line) => line.includes('already exists'))) {
    throw new Error(`Creating network ${name} failed: ${create.tail.at(-1)}`);
  }
}

// docker build --file <dockerfile> --tag <image> <context>. Output lines go to
// `onLine`; the exit code tells the caller whether the build succeeded.
export function buildImage({ contextDir, dockerfile, image, extraTags = [], labels, onLine }) {
  const args = ['build', '--progress=plain', '--file', dockerfile, '--tag', image];
  for (const tag of extraTags) args.push('--tag', tag);
  for (const label of labels) args.push('--label', label);
  args.push('--', contextDir);
  return docker(args, { onLine, timeoutMs: config.docker.buildTimeoutMs, tailSize: 40 });
}

// Starts the application container with a deliberately small surface:
// - no environment variables from DeployX (no DATABASE_URL, REDIS_URL, ...)
// - no volumes or bind mounts, no Docker socket
// - not privileged, reduced capabilities, no-new-privileges
// - memory, CPU and process limits, bounded log files
// - only the app network, container port published on 127.0.0.1 only
export async function runContainer({ image, name, containerPort, labels }) {
  const args = [
    'run', '--detach',
    '--name', name,
    '--network', config.docker.appNetwork,
    '--publish', `127.0.0.1::${containerPort}`,
    '--security-opt', 'no-new-privileges:true',
    '--cap-drop', 'ALL',
    ...APP_CAPABILITIES.flatMap((cap) => ['--cap-add', cap]),
    '--memory', config.docker.appMemory,
    '--cpus', config.docker.appCpus,
    '--pids-limit', String(config.docker.appPidsLimit),
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
    '--restart', 'no',
  ];
  for (const label of labels) args.push('--label', label);
  args.push('--', image);

  const result = await docker(args);
  const containerId = result.stdout.trim().split(/\s+/).at(-1);
  if (result.code !== 0 || !/^[0-9a-f]{64}$/.test(containerId ?? '')) {
    throw new Error(`docker run failed: ${result.tail.at(-1) ?? `exit code ${result.code}`}`);
  }
  return containerId;
}

// Returns Docker's view of the container, or null if it does not exist.
export async function inspectContainer(nameOrId) {
  const result = await docker(['container', 'inspect', '--', nameOrId]);
  if (result.code !== 0) return null;
  return JSON.parse(result.stdout)[0] ?? null;
}

export function publishedHostPort(inspection, containerPort) {
  const bindings = inspection?.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  const hostPort = Number(bindings?.[0]?.HostPort);
  return Number.isInteger(hostPort) && hostPort > 0 ? hostPort : null;
}

// The host port of a container's single published port, whatever the
// container port is (DeployX publishes exactly one port per container).
export function firstPublishedHostPort(inspection) {
  for (const bindings of Object.values(inspection?.NetworkSettings?.Ports ?? {})) {
    const hostPort = Number(bindings?.[0]?.HostPort);
    if (Number.isInteger(hostPort) && hostPort > 0) return hostPort;
  }
  return null;
}

// The immutable ID (sha256:...) of an image, or null if the image does not
// exist. A tag can be moved to another image by a later build; the ID cannot.
export async function imageId(image) {
  const result = await docker(['image', 'inspect', '--format', '{{.Id}}', '--', image]);
  const id = result.stdout.trim();
  return result.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

// Whether the image (a tag or an ID) is still present on the Docker host.
export async function imageExists(image) {
  const result = await docker(['image', 'inspect', '--format', '{{.Id}}', '--', image]);
  return result.code === 0;
}

export async function containerLogs(nameOrId, tail = 30) {
  const result = await docker(['logs', '--tail', String(tail), '--', nameOrId]);
  return result.tail;
}

export async function removeContainer(nameOrId) {
  await dockerOrThrow(['rm', '--force', '--', nameOrId], `Removing container ${nameOrId}`);
}

// All DeployX containers of a project (running or not): [{ id, name, deploymentId }].
export async function listProjectContainers(projectId) {
  const result = await dockerOrThrow(
    [
      'ps', '--all', '--no-trunc',
      '--filter', `label=${MANAGED_LABEL}`,
      '--filter', `label=deployx.project=${projectId}`,
      '--format', '{{.ID}}\t{{.Names}}\t{{.Label "deployx.deployment"}}',
    ],
    'Listing project containers',
  );
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, name, deploymentId] = line.split('\t');
      return { id, name, deploymentId };
    });
}
