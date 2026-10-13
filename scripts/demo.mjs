// A repeatable local demo of DeployX's main path, driven through the API:
//
//   1. sign in
//   2. create (or reuse) an application for examples/hello-app of this repository
//   3. deploy it: QUEUED -> BUILDING -> DEPLOYING -> HEALTH_CHECK -> SUCCESS
//   4. point the application at examples/unhealthy-app and deploy again: the
//      health check fails, ROLLING_BACK restores the stable version -> FAILED
//   5. check that the stable version still answers, and print the monitoring
//      summary and the dashboard links
//
// It needs a running stack (docker compose up --build) and an account:
//
//   npm run user:create -- --email demo@deployx.local --name "Demo" --role ADMIN
//   DEMO_EMAIL=demo@deployx.local DEMO_PASSWORD=... npm run demo
//
// The password is read from DEMO_PASSWORD only (never a command-line
// argument). Each run adds two deployments to the one demo application and
// leaves it pointing at hello-app again, so the demo can be repeated. It exits
// with code 1 when anything does not behave as described above.

const API = (process.env.DEPLOYX_API_URL || 'http://localhost:5000').replace(/\/$/, '');
const DASHBOARD = (process.env.DEPLOYX_DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.DEMO_EMAIL;
const PASSWORD = process.env.DEMO_PASSWORD;
const PROJECT_NAME = process.env.DEMO_PROJECT || 'demo-rollback';
const REPOSITORY = process.env.DEMO_REPOSITORY || 'https://github.com/devtejasx/DeployX';
const BRANCH = process.env.DEMO_BRANCH || 'main';
// Where the worker publishes app ports (127.0.0.1 on the Docker host).
const APP_HOST = process.env.DEMO_APP_HOST || '127.0.0.1';
const TIMEOUT_MS = Number(process.env.DEMO_TIMEOUT_MS) || 5 * 60 * 1000;

const HEALTHY_DOCKERFILE = 'examples/hello-app/Dockerfile';
const UNHEALTHY_DOCKERFILE = 'examples/unhealthy-app/Dockerfile';
const FINAL = new Set(['SUCCESS', 'FAILED', 'ROLLBACK_FAILED']);

let cookie = null;
const started = Date.now();

const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;
const say = (message) => console.log(`${elapsed()}  ${message}`);
const step = (title) => console.log(`\n== ${title}`);

class DemoError extends Error {}
function expect(condition, message) {
  if (!condition) throw new DemoError(message);
}

async function api(method, path, body) {
  const response = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const details = payload?.error?.details?.length ? ` (${payload.error.details.join('; ')})` : '';
    throw new DemoError(`${method} /api${path} answered ${response.status}: ${payload?.error?.message ?? 'no JSON body'}${details}`);
  }
  if (path === '/auth/login') {
    cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
  }
  return payload.data;
}

async function signIn() {
  expect(EMAIL && PASSWORD, 'Set DEMO_EMAIL and DEMO_PASSWORD (create the account with npm run user:create).');
  const { user } = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  say(`signed in as ${user.email} (${user.role})`);
}

async function demoProject() {
  const settings = {
    github_repo: REPOSITORY,
    github_branch: BRANCH,
    dockerfile_path: HEALTHY_DOCKERFILE,
    container_port: 3000,
    health_check_path: '/health',
    deployment_target: 'LOCAL',
  };
  const existing = (await api('GET', '/projects')).find((project) => project.name === PROJECT_NAME);
  if (existing) {
    const project = await api('PUT', `/projects/${existing.id}`, settings);
    say(`reusing application "${project.name}" (${project.id})`);
    return project;
  }
  const project = await api('POST', '/projects', { name: PROJECT_NAME, ...settings });
  say(`created application "${project.name}" (${project.id})`);
  return project;
}

// Queues a deployment and follows it until it is final, printing every status
// change and the latest log line while it runs.
async function deployAndFollow(project) {
  const { deployment } = await api('POST', `/projects/${project.id}/deployments`, {});
  say(`queued deployment ${deployment.id}`);
  let lastStatus = null;
  let lastLogId = null;
  for (;;) {
    expect(Date.now() - started < TIMEOUT_MS, `Timed out waiting for deployment ${deployment.id}`);
    const current = await api('GET', `/deployments/${deployment.id}`);
    if (current.status !== lastStatus) {
      say(`status ${current.status}`);
      lastStatus = current.status;
    }
    const logs = await api('GET', `/deployments/${deployment.id}/logs`);
    for (const line of logs.slice(logs.findIndex((log) => log.id === lastLogId) + 1)) {
      // The lifecycle lines; Docker's own build output ("#7 ...") is left to the dashboard.
      if (!line.message.startsWith('#') && /health check|rollback|stable|container|image|clon/i.test(line.message)) {
        say(`  log: ${line.message}`);
      }
    }
    if (logs.length) lastLogId = logs.at(-1).id;
    if (FINAL.has(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function appAnswers(deployment) {
  expect(deployment.host_port, `Deployment ${deployment.id} has no published port`);
  const url = `http://${APP_HOST}:${deployment.host_port}`;
  const health = await fetch(`${url}/health`);
  const home = await fetch(`${url}/`).then((response) => response.text());
  say(`${url}/health -> HTTP ${health.status}; GET / -> ${JSON.stringify(home.trim())}`);
  return health.status === 200 && home.includes('Hello from DeployX');
}

async function main() {
  console.log(`DeployX demo against ${API}`);

  step('1. Sign in and prepare the demo application');
  await signIn();
  let project = await demoProject();

  step('2. Deploy a healthy version (examples/hello-app)');
  const healthy = await deployAndFollow(project);
  expect(healthy.status === 'SUCCESS', `Expected SUCCESS, got ${healthy.status}: ${healthy.error_message}`);
  expect(healthy.is_stable, 'The healthy deployment should be the stable one');
  expect(await appAnswers(healthy), 'The healthy version does not answer on its port');

  step('3. Deploy an unhealthy version (examples/unhealthy-app: GET /health -> 503)');
  project = await api('PUT', `/projects/${project.id}`, { dockerfile_path: UNHEALTHY_DOCKERFILE });
  const unhealthy = await deployAndFollow(project);
  expect(unhealthy.status === 'FAILED', `Expected FAILED, got ${unhealthy.status}`);
  expect(unhealthy.rollback_status === 'COMPLETED', `Expected rollback COMPLETED, got ${unhealthy.rollback_status}`);
  expect(
    unhealthy.rollback_deployment_id === healthy.id,
    `Expected the rollback to restore ${healthy.id}, got ${unhealthy.rollback_deployment_id}`,
  );
  say(`rollback ${unhealthy.rollback_status}: restored deployment ${unhealthy.rollback_deployment_id}`);

  step('4. The stable version is still live');
  const stable = await api('GET', `/deployments/${healthy.id}`);
  expect(stable.is_stable, 'The first deployment should still be stable');
  expect(await appAnswers(stable), 'The stable version stopped answering');
  await api('PUT', `/projects/${project.id}`, { dockerfile_path: HEALTHY_DOCKERFILE });
  say(`application "${project.name}" points at ${HEALTHY_DOCKERFILE} again`);

  step('5. History and monitoring');
  const history = await api('GET', `/projects/${project.id}/deployments`);
  for (const [index, deployment] of history.entries()) {
    const rollback = deployment.rollback_status ? ` · rollback ${deployment.rollback_status}` : '';
    console.log(`  #${history.length - index}  ${deployment.status.padEnd(8)}${deployment.is_stable ? ' · stable' : ''}${rollback}  ${deployment.id}`);
  }
  const overview = await api('GET', '/monitoring/overview');
  const last24 = overview.deployments?.last24Hours ?? {};
  console.log(
    `  monitoring: ${overview.workers?.running ?? '?'} worker(s), queue waiting ${overview.queue?.waiting ?? '?'}, ` +
      `last 24 h ${last24.SUCCESS ?? 0} succeeded / ${last24.FAILED ?? 0} failed, ` +
      `${overview.deployments?.rollbacksLast24Hours ?? 0} rollback(s), ${overview.alerts.length} alert(s)`,
  );

  console.log(`\nDemo completed in ${elapsed().trim()}. Open the dashboard:`);
  console.log(`  ${DASHBOARD}/#/projects/${project.id}/deployments/${healthy.id}    (healthy, stable)`);
  console.log(`  ${DASHBOARD}/#/projects/${project.id}/deployments/${unhealthy.id}    (failed health check, rolled back)`);
}

try {
  await main();
} catch (err) {
  console.error(`\nDemo failed: ${err.message}`);
  if (!(err instanceof DemoError)) console.error(err);
  process.exitCode = 1;
}
