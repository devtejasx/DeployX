// Authorization: users only reach their own projects and deployments; ADMIN
// reaches everything and alone may use the operator endpoints. Enforced by
// the API, whatever the dashboard shows.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, openLogStream, pool, projectPayload, setupTestServer } from './helpers.js';

let api;
let alice;
let bob;
let aliceProject;
let aliceDeployment;

before(async () => {
  api = await setupTestServer();
  alice = await api.clientFor({ name: 'Alice', email: 'alice@example.com' });
  bob = await api.clientFor({ name: 'Bob', email: 'bob@example.com' });
  aliceProject = (await alice.post('/api/projects', projectPayload())).body.data;
  aliceDeployment = (await alice.post(`/api/projects/${aliceProject.id}/deployments`, {})).body.data.deployment;
});

after(() => api.close());

describe('ownership', () => {
  test('a project belongs to whoever created it; user_id cannot be chosen', async () => {
    assert.equal(aliceProject.user_id, alice.user.id);
    const forged = await bob.post('/api/projects', { ...projectPayload(), user_id: alice.user.id });
    assert.equal(forged.status, 400);
    assert.deepEqual(forged.body.error.details, ['Unknown or read-only field(s): user_id']);
  });

  test("another user's project and everything in it answers 403", async () => {
    const id = aliceProject.id;
    const deploymentId = aliceDeployment.id;
    for (const [method, path, body] of [
      ['GET', `/api/projects/${id}`],
      ['PUT', `/api/projects/${id}`, { name: 'Taken over' }],
      ['PUT', `/api/projects/${id}`, { github_repo: 'https://github.com/bob/evil' }],
      ['PUT', `/api/projects/${id}`, { deployment_target: 'AWS_ECS', aws_ecs_service: 'x', aws_service_url: 'https://x.example.com' }],
      ['DELETE', `/api/projects/${id}`],
      ['GET', `/api/projects/${id}/deployments`],
      ['POST', `/api/projects/${id}/deployments`, {}],
      ['GET', `/api/deployments/${deploymentId}`],
      ['GET', `/api/deployments/${deploymentId}/logs`],
    ]) {
      const response = await bob.request(method, path, body);
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.match(response.body.error.message, /^You do not have access to this (project|deployment)$/);
    }

    // Nothing changed, nothing was queued.
    const project = await alice.get(`/api/projects/${id}`);
    assert.equal(project.body.data.name, aliceProject.name);
    assert.equal(project.body.data.github_repo, aliceProject.github_repo);
    const deployments = await alice.get(`/api/projects/${id}/deployments`);
    assert.equal(deployments.body.data.length, 1);
  });

  test("another user's live log stream is refused before it starts", async () => {
    const stream = await openLogStream(api.baseUrl, aliceDeployment.id, { cookie: bob.cookie });
    assert.equal(stream.response.status, 403);
    assert.match(stream.response.headers.get('content-type'), /application\/json/);
    await stream.response.body?.cancel();

    const own = await openLogStream(api.baseUrl, aliceDeployment.id, { cookie: alice.cookie });
    assert.equal(own.response.status, 200);
    own.close();
  });

  test('listing shows a USER only its own projects', async () => {
    const bobProject = (await bob.post('/api/projects', projectPayload())).body.data;
    const bobList = (await bob.get('/api/projects')).body.data.map((project) => project.id);
    assert.deepEqual(bobList, [bobProject.id]);
    const aliceList = (await alice.get('/api/projects')).body.data.map((project) => project.id);
    assert.ok(!aliceList.includes(bobProject.id));
  });

  test('missing resources are still 404, malformed IDs 400', async () => {
    assert.equal((await bob.get(`/api/projects/${MISSING_ID}`)).status, 404);
    assert.equal((await bob.get(`/api/deployments/${MISSING_ID}`)).status, 404);
    assert.equal((await bob.get('/api/projects/not-a-uuid')).status, 400);
  });

  test('the owner reaches everything of its own project', async () => {
    assert.equal((await alice.get(`/api/projects/${aliceProject.id}`)).status, 200);
    assert.equal((await alice.get(`/api/deployments/${aliceDeployment.id}`)).status, 200);
    assert.equal((await alice.get(`/api/deployments/${aliceDeployment.id}/logs`)).status, 200);
    assert.equal((await alice.put(`/api/projects/${aliceProject.id}`, { description: 'mine' })).status, 200);
  });
});

describe('roles', () => {
  test('ADMIN sees and manages every project', async () => {
    const all = (await api.get('/api/projects')).body.data.map((project) => project.id);
    assert.ok(all.includes(aliceProject.id));
    assert.equal((await api.get(`/api/deployments/${aliceDeployment.id}`)).status, 200);
    assert.equal((await api.put(`/api/projects/${aliceProject.id}`, { description: 'by admin' })).status, 200);
    // Still Alice's project.
    assert.equal((await alice.get(`/api/projects/${aliceProject.id}`)).body.data.user_id, alice.user.id);
  });

  test('only ADMIN may override a status or write raw log lines, even on its own project', async () => {
    const status = await alice.patch(`/api/deployments/${aliceDeployment.id}/status`, { status: 'FAILED' });
    assert.equal(status.status, 403);
    assert.equal(status.body.error.message, 'You do not have permission to do this');
    const log = await alice.post(`/api/deployments/${aliceDeployment.id}/logs`, { level: 'INFO', message: 'fake' });
    assert.equal(log.status, 403);

    const { rows } = await pool.query('SELECT status FROM deployments WHERE id = $1', [aliceDeployment.id]);
    assert.notEqual(rows[0].status, 'FAILED');
    assert.equal((await api.post(`/api/deployments/${aliceDeployment.id}/logs`, { level: 'INFO', message: 'note' })).status, 201);
  });

  test('a USER cannot make itself ADMIN through the API', async () => {
    assert.equal((await alice.put(`/api/projects/${aliceProject.id}`, { user_id: bob.user.id })).status, 400);
    assert.equal((await alice.post('/api/auth/register', { name: 'x', email: 'x@example.com', password: 'p'.repeat(12), role: 'ADMIN' })).status, 400);
    assert.equal((await alice.get('/api/auth/me')).body.data.user.role, 'USER');
  });
});

describe('audit log', () => {
  test('records project and deployment actions, and denied access', async () => {
    const { rows } = await pool.query(
      `SELECT action, target_id, details FROM audit_logs WHERE user_id = $1 ORDER BY id`,
      [alice.user.id],
    );
    const actions = rows.map((row) => row.action);
    assert.ok(actions.includes('auth.login'));
    assert.ok(actions.includes('project.created'));
    assert.ok(actions.includes('deployment.created'));
    assert.ok(actions.includes('project.updated'));
    assert.ok(actions.includes('access.denied'), 'the denied status override');

    const denied = await pool.query(`SELECT details FROM audit_logs WHERE user_id = $1 AND action = 'access.denied'`, [bob.user.id]);
    assert.ok(denied.rows.length >= 9);
    assert.ok(denied.rows.some((row) => row.details.path === `/api/projects/${aliceProject.id}` && row.details.method === 'DELETE'));
  });

  test('GET /api/audit-logs: a USER reads its own entries, ADMIN every entry, newest first', async () => {
    const own = await bob.get('/api/audit-logs?limit=200');
    assert.equal(own.status, 200);
    assert.ok(own.body.data.length > 0);
    assert.ok(own.body.data.every((entry) => entry.user_id === bob.user.id));

    const everything = await api.get('/api/audit-logs?limit=200');
    const users = new Set(everything.body.data.map((entry) => entry.user_id));
    assert.ok(users.has(alice.user.id) && users.has(bob.user.id));
    const ids = everything.body.data.map((entry) => BigInt(entry.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? 1 : -1)));

    const page = await api.get(`/api/audit-logs?limit=2&before=${everything.body.data[1].id}`);
    assert.equal(page.body.data[0].id, everything.body.data[2].id);

    for (const query of ['limit=0', 'limit=500', 'limit=abc', 'before=-1', 'before=1;DROP', 'other=1']) {
      assert.equal((await api.get(`/api/audit-logs?${query}`)).status, 400, query);
    }
    assert.equal((await api.anonymous.get('/api/audit-logs')).status, 401);
  });
});
