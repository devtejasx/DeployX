// GitHub push webhooks: POST /api/webhooks/github.
//
// Signature verification, push parsing, project and branch matching, and the
// hand-over to the SAME deployment path as manual deployments (a QUEUED record
// and a BullMQ job). No worker runs here: the jobs stay in the test queue,
// which is exactly what the webhook is responsible for.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { WEBHOOK_SECRET, pushPayload, randomSha, sendWebhook, sign } from './githubWebhook.js';
import { getDeploymentQueue, pool, projectPayload, setupTestServer } from './helpers.js';

let api;
let config;

before(async () => {
  // The webhook reports each push on the console.
  mock.method(console, 'log', () => {});
  api = await setupTestServer();
  ({ default: config } = await import('../src/config/index.js'));
});

beforeEach(() => {
  config.github.webhookSecret = WEBHOOK_SECRET;
});

after(async () => {
  await api.close();
  mock.restoreAll();
});

let repoCounter = 0;

// A project connected to its own repository, so tests never see each other's
// deployments.
async function createProject(overrides = {}) {
  repoCounter += 1;
  const { status, body } = await api.post(
    '/api/projects',
    projectPayload({ github_repo: `https://github.com/octo-org/app-${repoCounter}`, ...overrides }),
  );
  assert.equal(status, 201, JSON.stringify(body));
  return body.data;
}

function send(options) {
  return sendWebhook(api.baseUrl, options);
}

async function deploymentsOf(project) {
  return (await api.get(`/api/projects/${project.id}/deployments`)).body.data;
}

async function logMessages(deploymentId) {
  return (await api.get(`/api/deployments/${deploymentId}/logs`)).body.data.map((line) => line.message);
}

async function deploymentCount() {
  return (await pool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n;
}

describe('webhook security', () => {
  test('a valid push with a valid signature is accepted', async () => {
    const project = await createProject();
    const { status, body } = await send({ payload: pushPayload({ repo: project.github_repo }) });
    assert.equal(status, 202, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(body.data.deployments.length, 1);
  });

  test('a delivery without a signature is refused and changes nothing', async () => {
    const project = await createProject();
    const before = await deploymentCount();
    const { status, body } = await send({ payload: pushPayload({ repo: project.github_repo }), signature: null });
    assert.equal(status, 401);
    assert.deepEqual(body, { success: false, error: { message: 'Missing X-Hub-Signature-256 header' } });
    assert.equal(await deploymentCount(), before);
  });

  test('an invalid signature is refused: wrong secret, altered body, wrong format', async () => {
    const project = await createProject();
    const payload = pushPayload({ repo: project.github_repo });
    const body = JSON.stringify(payload);
    const before = await deploymentCount();

    const altered = JSON.stringify({ ...payload, ref: 'refs/heads/main', after: randomSha() });
    for (const [label, options] of [
      ['wrong secret', { rawBody: body, secret: 'not-the-secret' }],
      ['altered body', { rawBody: altered, signature: sign(body) }],
      ['sha1 signature', { rawBody: body, signature: `sha1=${'a'.repeat(40)}` }],
      ['not hex', { rawBody: body, signature: `sha256=${'z'.repeat(64)}` }],
      ['too short', { rawBody: body, signature: sign(body).slice(0, -2) }],
      ['upper-case prefix', { rawBody: body, signature: sign(body).replace('sha256', 'SHA256') }],
      ['empty', { rawBody: body, signature: '' }],
    ]) {
      const response = await send(options);
      assert.equal(response.status, 401, label);
      assert.match(response.body.error.message, /^(Invalid webhook signature|Missing X-Hub-Signature-256 header)$/, label);
    }
    assert.equal(await deploymentCount(), before);
  });

  test('without a configured secret, webhooks are refused rather than processed unauthenticated', async () => {
    const project = await createProject();
    config.github.webhookSecret = '';
    const { status, body } = await send({ payload: pushPayload({ repo: project.github_repo }) });
    assert.equal(status, 503);
    assert.equal(body.error.message, 'GitHub webhooks are not configured on this server');
    assert.deepEqual(await deploymentsOf(project), []);
  });

  test('the payload is only parsed after the signature is verified', async () => {
    // Malformed JSON with a bad signature: 401, not a parse error.
    const unsigned = await send({ rawBody: '{"ref": ', signature: sign('something else') });
    assert.equal(unsigned.status, 401);

    const signed = await send({ rawBody: '{"ref": ' });
    assert.equal(signed.status, 400);
    assert.equal(signed.body.error.message, 'Malformed JSON payload');
  });

  test('secrets and signatures never appear in responses or server logs', async (t) => {
    const lines = [];
    for (const method of ['log', 'warn', 'error']) {
      t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
    }
    const project = await createProject();
    const payload = pushPayload({ repo: project.github_repo });
    const signature = sign(JSON.stringify(payload));
    const responses = [
      await send({ payload, signature }),
      await send({ payload, secret: 'wrong' }),
      await send({ rawBody: '{', signature: sign('{') }),
    ];

    const everything = JSON.stringify(responses) + lines.join('\n');
    assert.ok(lines.some((line) => line.startsWith('[webhook] push to octo-org/')), lines.join('\n'));
    assert.ok(!everything.includes(WEBHOOK_SECRET));
    assert.ok(!everything.includes(signature.slice('sha256='.length)));
    const logs = await logMessages(responses[0].body.data.deployments[0].deployment_id);
    assert.ok(!logs.join('\n').includes(WEBHOOK_SECRET));
  });
});

describe('payload validation', () => {
  test('malformed payloads are rejected with the reason', async () => {
    const project = await createProject();
    const valid = pushPayload({ repo: project.github_repo });
    for (const [label, payload, detail] of [
      ['no after', { ...valid, after: undefined }, /^after: /],
      ['short sha', { ...valid, after: 'abc1234' }, /^after: after must be a 40-character commit SHA$/],
      ['upper-case sha', { ...valid, after: valid.after.toUpperCase() }, /^after: /],
      ['no repository', { ...valid, repository: undefined }, /^repository: /],
      ['ref not a string', { ...valid, ref: 42 }, /^ref: /],
      ['array', [valid], /^payload: /],
    ]) {
      const { status, body } = await send({ payload });
      assert.equal(status, 400, label);
      assert.equal(body.error.message, 'Invalid push payload', label);
      assert.match(body.error.details[0], detail, label);
    }
    const badBranch = await send({ payload: { ...valid, ref: 'refs/heads/../../etc' } });
    assert.equal(badBranch.status, 400);
    assert.deepEqual(badBranch.body.error.details, ['ref: not a valid branch name']);
    assert.deepEqual(await deploymentsOf(project), []);
  });

  test('only JSON deliveries are accepted', async () => {
    const payload = `payload=${encodeURIComponent(JSON.stringify(pushPayload()))}`;
    const { status, body } = await send({ rawBody: payload, contentType: 'application/x-www-form-urlencoded' });
    assert.equal(status, 415);
    assert.match(body.error.message, /set the webhook content type to application\/json/);
  });

  test('ping is answered, other events are refused, a missing event header is an error', async () => {
    const ping = await send({ event: 'ping', payload: { zen: 'Design for failure.', hook_id: 1 } });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body.data, { event: 'ping', message: 'Webhook is configured' });

    const issues = await send({ event: 'issues', payload: { action: 'opened' } });
    assert.equal(issues.status, 400);
    assert.equal(issues.body.error.message, 'Unsupported GitHub event "issues": only push events are handled');

    const odd = await send({ event: '<script>', payload: {} });
    assert.equal(odd.status, 400);
    assert.equal(odd.body.error.message, 'Unsupported GitHub event: only push events are handled');

    const none = await send({ event: null, payload: pushPayload() });
    assert.equal(none.status, 400);
    assert.equal(none.body.error.message, 'Missing X-GitHub-Event header');
  });

  test('payloads over the size limit are refused', async () => {
    const huge = JSON.stringify({ ...pushPayload(), padding: 'x'.repeat(6 * 1024 * 1024) });
    const { status } = await send({ rawBody: huge });
    assert.equal(status, 413);
  });
});

describe('push handling', () => {
  test('a push to the configured branch creates a deployment of that exact commit and queues it', async () => {
    const project = await createProject({ github_branch: 'main' });
    const sha = randomSha();
    const delivery = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
    const { status, body } = await send({
      payload: pushPayload({ repo: project.github_repo, sha, message: 'Add login page\n\nLonger description' }),
      delivery,
    });

    assert.equal(status, 202);
    const repository = project.github_repo.replace('https://github.com/', '');
    assert.deepEqual(body.data, {
      event: 'push',
      delivery,
      repository,
      branch: 'main',
      commit_sha: sha,
      deployments: [{ project_id: project.id, deployment_id: body.data.deployments[0].deployment_id, duplicate: false }],
      ignored: [],
      message: '1 deployment queued',
    });

    const { deployment_id: deploymentId } = body.data.deployments[0];
    const deployment = (await api.get(`/api/deployments/${deploymentId}`)).body.data;
    assert.equal(deployment.status, 'QUEUED');
    assert.equal(deployment.trigger, 'GITHUB_PUSH');
    assert.equal(deployment.commit_sha, sha);
    assert.equal(deployment.branch, 'main');
    assert.equal(deployment.deployment_target, 'LOCAL');
    assert.equal(deployment.project_id, project.id);

    // The same job as a manual deployment: same queue, same name, same payload.
    const job = await getDeploymentQueue().getJob(deploymentId);
    assert.equal(job.name, 'deploy');
    assert.deepEqual(job.data, { deploymentId, projectId: project.id, commitSha: sha, branch: 'main' });

    assert.deepEqual(await logMessages(deploymentId), [
      `GitHub webhook received: push to main (delivery ${delivery})`,
      `Repository identified: ${repository}, deploying branch main`,
      `Commit identified: ${sha} (Add login page)`,
      'Deployment created',
    ]);
  });

  test('a push to another branch is ignored', async () => {
    const project = await createProject({ github_branch: 'main' });
    const { status, body } = await send({ payload: pushPayload({ repo: project.github_repo, branch: 'development' }) });
    assert.equal(status, 200);
    assert.deepEqual(body.data.deployments, []);
    assert.deepEqual(body.data.ignored, [{ project_id: project.id, reason: 'Project deploys branch main, not development' }]);
    assert.equal(body.data.message, 'No project deploys branch development: push ignored');
    assert.deepEqual(await deploymentsOf(project), []);
  });

  test('tag pushes and branch deletions are ignored', async () => {
    const project = await createProject();
    const tag = await send({ payload: { ...pushPayload({ repo: project.github_repo }), ref: 'refs/tags/v1.0.0' } });
    assert.equal(tag.status, 200);
    assert.equal(tag.body.data.message, 'Not a branch push: only branches are deployed');

    const deletion = await send({
      payload: { ...pushPayload({ repo: project.github_repo }), after: '0'.repeat(40), deleted: true, head_commit: null },
    });
    assert.equal(deletion.status, 200);
    assert.equal(deletion.body.data.message, 'Branch main was deleted: nothing to deploy');
    assert.deepEqual(await deploymentsOf(project), []);
  });

  test('a push to a repository no project uses is refused with 404', async () => {
    const before = await deploymentCount();
    const { status, body } = await send({ payload: pushPayload({ repo: 'https://github.com/someone/unknown-repo' }) });
    assert.equal(status, 404);
    assert.equal(body.error.message, 'No DeployX project uses repository someone/unknown-repo');

    const notGitHub = await send({
      payload: { ...pushPayload(), repository: { html_url: 'https://gitlab.com/a/b', full_name: 'a/b' } },
    });
    assert.equal(notGitHub.status, 404);
    assert.equal(await deploymentCount(), before);
  });

  test('repositories match case-insensitively; each project of the repository is handled on its own', async () => {
    const repo = 'https://github.com/Octo-Org/Shared-Repo';
    const main = await createProject({ github_repo: `${repo}.git`, github_branch: 'main' });
    const develop = await createProject({ github_repo: repo, github_branch: 'develop' });
    const inactive = await createProject({ github_repo: repo, github_branch: 'main', status: 'INACTIVE' });

    const sha = randomSha();
    const { status, body } = await send({ payload: pushPayload({ repo: 'https://github.com/octo-org/shared-repo', sha }) });
    assert.equal(status, 202);
    assert.equal(body.data.deployments.length, 1);
    assert.equal(body.data.deployments[0].project_id, main.id);
    assert.deepEqual(
      body.data.ignored.sort((a, b) => a.reason.localeCompare(b.reason)),
      [
        { project_id: develop.id, reason: 'Project deploys branch develop, not main' },
        { project_id: inactive.id, reason: 'Project is inactive' },
      ],
    );
    assert.equal((await deploymentsOf(main))[0].commit_sha, sha);
    assert.deepEqual(await deploymentsOf(develop), []);
    assert.deepEqual(await deploymentsOf(inactive), []);
  });

  test('a push to a branch with slashes is matched exactly', async () => {
    const project = await createProject({ github_branch: 'release/2.0' });
    const ignored = await send({ payload: pushPayload({ repo: project.github_repo, branch: 'release/2' }) });
    assert.equal(ignored.status, 200);
    const deployed = await send({ payload: pushPayload({ repo: project.github_repo, branch: 'release/2.0' }) });
    assert.equal(deployed.status, 202);
    assert.equal((await deploymentsOf(project))[0].branch, 'release/2.0');
  });

  test('the commit summary is one clean line', async () => {
    const project = await createProject();
    const sha = randomSha();
    const message = `\u001b[31mFix \u0007bug​ ${'x'.repeat(200)}\nsecond line`;
    const { body } = await send({ payload: pushPayload({ repo: project.github_repo, sha, message }) });
    const [, , commitLine] = await logMessages(body.data.deployments[0].deployment_id);
    assert.equal(commitLine, `Commit identified: ${sha} ([31mFix bug ${'x'.repeat(107)}…)`);

    const noHead = await send({ payload: { ...pushPayload({ repo: project.github_repo }), head_commit: null } });
    const lines = await logMessages(noHead.body.data.deployments[0].deployment_id);
    assert.equal(lines[2], `Commit identified: ${noHead.body.data.commit_sha}`);
  });
});

describe('duplicate deliveries', () => {
  test('a redelivered push does not create a second deployment', async () => {
    const project = await createProject();
    const payload = pushPayload({ repo: project.github_repo });
    const delivery = '11111111-2222-4333-8444-555555555555';

    const first = await send({ payload, delivery });
    const again = await send({ payload, delivery });
    assert.equal(first.status, 202);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.message, 'Already deployed: this commit was received before');
    assert.deepEqual(again.body.data.deployments, [
      { project_id: project.id, deployment_id: first.body.data.deployments[0].deployment_id, duplicate: true },
    ]);

    const deployments = await deploymentsOf(project);
    assert.equal(deployments.length, 1);
    // The duplicate wrote nothing to the existing deployment either.
    assert.equal((await logMessages(deployments[0].id)).length, 4);
    assert.equal((await getDeploymentQueue().getJobs(['waiting', 'delayed', 'active'])).filter((job) => job.data.projectId === project.id).length, 1);
  });

  test('simultaneous deliveries of the same push create exactly one deployment', async () => {
    const project = await createProject();
    const payload = pushPayload({ repo: project.github_repo });
    const responses = await Promise.all(Array.from({ length: 8 }, () => send({ payload })));

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 200, 200, 200, 200, 202]);
    const ids = new Set(responses.map((response) => response.body.data.deployments[0].deployment_id));
    assert.equal(ids.size, 1);
    assert.equal((await deploymentsOf(project)).length, 1);
  });

  test('the same commit is deployed once per project, and a new commit is a new deployment', async () => {
    const repo = 'https://github.com/octo-org/twice-used';
    const a = await createProject({ github_repo: repo });
    const b = await createProject({ github_repo: repo });
    const sha = randomSha();

    const first = await send({ payload: pushPayload({ repo, sha }) });
    assert.equal(first.body.data.deployments.length, 2);
    assert.ok(first.body.data.deployments.every((deployment) => !deployment.duplicate));
    const next = await send({ payload: pushPayload({ repo }) });
    assert.equal(next.status, 202);
    assert.equal((await deploymentsOf(a)).length, 2);
    assert.equal((await deploymentsOf(b)).length, 2);
  });
});

describe('manual deployments', () => {
  test('still work, are MANUAL, and are not affected by push deduplication', async () => {
    const project = await createProject();
    const sha = randomSha();

    const pushed = await send({ payload: pushPayload({ repo: project.github_repo, sha }) });
    assert.equal(pushed.status, 202);

    // Redeploying the same commit by hand is always possible.
    const manual = await api.post(`/api/projects/${project.id}/deployments`, { commit_sha: sha });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.data.deployment.trigger, 'MANUAL');
    assert.equal(manual.body.data.deployment.commit_sha, sha);
    assert.deepEqual(await logMessages(manual.body.data.deployment.id), ['Deployment created']);
    const job = await getDeploymentQueue().getJob(manual.body.data.deployment.id);
    assert.equal(job.name, 'deploy');

    const history = await deploymentsOf(project);
    assert.deepEqual(
      history.map((deployment) => deployment.trigger),
      ['MANUAL', 'GITHUB_PUSH'],
    );
  });
});
