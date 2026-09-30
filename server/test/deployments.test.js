import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, getDeploymentQueue, pool, projectPayload, setupTestServer } from './helpers.js';

let api;
let project;

before(async () => {
  api = await setupTestServer();
  const created = await api.post('/api/projects', projectPayload({ github_branch: 'develop' }));
  project = created.body.data;
});

after(() => api.close());

async function createDeployment(body = {}) {
  const { status, body: response } = await api.post(`/api/projects/${project.id}/deployments`, body);
  assert.equal(status, 201);
  return response.data.deployment;
}

describe('POST /api/projects/:projectId/deployments', () => {
  test('creates a QUEUED deployment record and queues a job for it', async () => {
    const { status, body } = await api.post(`/api/projects/${project.id}/deployments`, {
      commit_sha: 'ABC1234',
      branch: 'main',
    });

    assert.equal(status, 201);
    assert.equal(body.success, true);
    const { deployment, jobId } = body.data;
    assert.equal(deployment.project_id, project.id);
    assert.equal(deployment.commit_sha, 'abc1234');
    assert.equal(deployment.branch, 'main');
    assert.equal(deployment.status, 'QUEUED');
    assert.equal(deployment.docker_image, null);
    assert.equal(deployment.started_at, null);
    assert.equal(deployment.finished_at, null);
    assert.deepEqual(deployment.project, { id: project.id, name: project.name, github_repo: project.github_repo });

    // The BullMQ job is identified by the deployment ID and carries only identifiers.
    assert.equal(jobId, deployment.id);
    const job = await getDeploymentQueue().getJob(jobId);
    assert.equal(job.name, 'deploy');
    assert.deepEqual(job.data, {
      deploymentId: deployment.id,
      projectId: project.id,
      commitSha: 'abc1234',
      branch: 'main',
    });
    assert.equal(job.opts.attempts, 3);
    assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 200 }); // test config

    const logs = await api.get(`/api/deployments/${deployment.id}/logs`);
    assert.deepEqual(
      logs.body.data.map(({ level, message }) => ({ level, message })),
      [{ level: 'INFO', message: 'Deployment created' }],
    );
  });

  test('marks the deployment FAILED and returns 503 when the queue is unavailable', async (t) => {
    t.mock.method(getDeploymentQueue(), 'add', async () => {
      throw new Error('Connection is closed.');
    });
    t.mock.method(console, 'error', () => {});

    const { status, body } = await api.post(`/api/projects/${project.id}/deployments`, {});
    assert.equal(status, 503);
    assert.deepEqual(body, {
      success: false,
      error: { message: 'Deployment queue is unavailable; the deployment was marked as FAILED' },
    });

    const { rows } = await pool.query(
      `SELECT id, status, finished_at FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [project.id],
    );
    assert.equal(rows[0].status, 'FAILED');
    assert.ok(rows[0].finished_at);

    const logs = await api.get(`/api/deployments/${rows[0].id}/logs`);
    assert.deepEqual(
      logs.body.data.map(({ level, message }) => ({ level, message })),
      [
        { level: 'INFO', message: 'Deployment created' },
        { level: 'ERROR', message: 'Could not add the deployment job to the queue (Redis unavailable)' },
      ],
    );
  });

  test("defaults the branch to the project's branch", async () => {
    const deployment = await createDeployment();
    assert.equal(deployment.branch, 'develop');
    assert.equal(deployment.commit_sha, null);
  });

  test('validates commit SHA and branch, and does not accept a status', async () => {
    const { status, body } = await api.post(`/api/projects/${project.id}/deployments`, {
      commit_sha: 'not-a-sha',
      branch: 'bad branch',
      status: 'SUCCESS',
    });
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, [
      'Commit SHA must be 7-40 hexadecimal characters',
      'Branch is not a valid git branch name',
      'Unknown or read-only field(s): status',
    ]);
  });

  test('returns 404 for a project that does not exist and 400 for a malformed ID', async () => {
    const missing = await api.post(`/api/projects/${MISSING_ID}/deployments`, {});
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.message, 'Project not found');

    const malformed = await api.post('/api/projects/123/deployments', {});
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body.error.details, ['Invalid project ID']);
  });

  test('refuses to deploy an inactive project', async () => {
    const inactive = await api.post('/api/projects', projectPayload({ status: 'INACTIVE' }));
    const { status, body } = await api.post(`/api/projects/${inactive.body.data.id}/deployments`, {});
    assert.equal(status, 409);
    assert.equal(body.error.message, 'Project is inactive; set its status to ACTIVE before deploying');
  });
});

describe('GET /api/projects/:projectId/deployments', () => {
  test('lists the project deployments newest first', async () => {
    const older = await createDeployment({ commit_sha: '1111111' });
    const newer = await createDeployment({ commit_sha: '2222222' });

    const { status, body } = await api.get(`/api/projects/${project.id}/deployments`);
    assert.equal(status, 200);
    assert.ok(body.data.every((deployment) => deployment.project_id === project.id));
    const ids = body.data.map((deployment) => deployment.id);
    assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id));

    const timestamps = body.data.map((deployment) => new Date(deployment.created_at).getTime());
    assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));
  });

  test('returns 404 for a project that does not exist', async () => {
    const { status } = await api.get(`/api/projects/${MISSING_ID}/deployments`);
    assert.equal(status, 404);
  });
});

describe('GET /api/deployments/:deploymentId', () => {
  test('returns the deployment with its project', async () => {
    const created = await createDeployment({ commit_sha: 'deadbeef' });
    const { status, body } = await api.get(`/api/deployments/${created.id}`);
    assert.equal(status, 200);
    assert.deepEqual(body.data, created);
  });

  test('returns 404 for a deployment that does not exist and 400 for a malformed ID', async () => {
    const missing = await api.get(`/api/deployments/${MISSING_ID}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.message, 'Deployment not found');

    const malformed = await api.get('/api/deployments/xyz');
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body.error.details, ['Invalid deployment ID']);
  });
});

describe('PATCH /api/deployments/:deploymentId/status', () => {
  test('moves through the statuses and records start and finish times', async () => {
    const deployment = await createDeployment();
    const patch = (status) => api.patch(`/api/deployments/${deployment.id}/status`, { status });

    const building = await patch('BUILDING');
    assert.equal(building.status, 200);
    assert.equal(building.body.data.status, 'BUILDING');
    assert.ok(building.body.data.started_at);
    assert.equal(building.body.data.finished_at, null);

    const deploying = await patch('DEPLOYING');
    assert.equal(deploying.body.data.started_at, building.body.data.started_at);

    await patch('HEALTH_CHECK');
    const success = await patch('SUCCESS');
    assert.equal(success.body.data.status, 'SUCCESS');
    assert.equal(success.body.data.started_at, building.body.data.started_at);
    assert.ok(success.body.data.finished_at);
  });

  test('FAILED also records a finish time', async () => {
    const deployment = await createDeployment();
    const { body } = await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'FAILED' });
    assert.equal(body.data.status, 'FAILED');
    // It never started work, so there is no start time (state machine rule).
    assert.equal(body.data.started_at, null);
    assert.ok(body.data.finished_at);
  });

  test('rejects statuses outside the allowed set', async () => {
    const deployment = await createDeployment();
    for (const status of ['DONE', 'success', '', 42]) {
      const response = await api.patch(`/api/deployments/${deployment.id}/status`, { status });
      assert.equal(response.status, 400, `status ${JSON.stringify(status)} should be rejected`);
      assert.deepEqual(response.body.error.details, [
        'Deployment status must be one of: QUEUED, BUILDING, DEPLOYING, HEALTH_CHECK, ROLLING_BACK, SUCCESS, FAILED, ROLLBACK_FAILED',
      ]);
    }

    const missing = await api.patch(`/api/deployments/${deployment.id}/status`, {});
    assert.deepEqual(missing.body.error.details, ['Deployment status is required']);

    const unchanged = await api.get(`/api/deployments/${deployment.id}`);
    assert.equal(unchanged.body.data.status, 'QUEUED');
  });

  test('returns 404 for a deployment that does not exist', async () => {
    const { status } = await api.patch(`/api/deployments/${MISSING_ID}/status`, { status: 'BUILDING' });
    assert.equal(status, 404);
  });
});

describe('deployment state machine through the API', () => {
  test('invalid transitions are rejected with 409 and the from/to states', async () => {
    const deployment = await createDeployment();
    const patch = (status) => api.patch(`/api/deployments/${deployment.id}/status`, { status });

    const skip = await patch('SUCCESS');
    assert.equal(skip.status, 409);
    assert.deepEqual(skip.body, {
      success: false,
      error: { message: 'Invalid deployment state transition', from: 'QUEUED', to: 'SUCCESS' },
    });

    await patch('BUILDING');
    await patch('DEPLOYING');
    // A running container is not enough: SUCCESS needs the health check.
    const unchecked = await patch('SUCCESS');
    assert.equal(unchecked.status, 409);
    assert.deepEqual(unchecked.body.error, {
      message: 'Invalid deployment state transition',
      from: 'DEPLOYING',
      to: 'SUCCESS',
    });
    for (const status of ['HEALTH_CHECK', 'SUCCESS']) {
      assert.equal((await patch(status)).status, 200);
    }
    for (const [to, from] of [
      ['BUILDING', 'SUCCESS'],
      ['QUEUED', 'SUCCESS'],
      ['FAILED', 'SUCCESS'],
    ]) {
      const { status, body } = await patch(to);
      assert.equal(status, 409, `${from} -> ${to}`);
      assert.deepEqual(body.error, { message: 'Invalid deployment state transition', from, to });
    }

    const unchanged = await api.get(`/api/deployments/${deployment.id}`);
    assert.equal(unchanged.body.data.status, 'SUCCESS');
  });

  test('FAILED is final too', async () => {
    const deployment = await createDeployment();
    await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'FAILED' });
    const { status, body } = await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'DEPLOYING' });
    assert.equal(status, 409);
    assert.deepEqual(body.error, { message: 'Invalid deployment state transition', from: 'FAILED', to: 'DEPLOYING' });
  });

  test('setting the current status again changes nothing', async () => {
    const deployment = await createDeployment();
    const { status, body } = await api.patch(`/api/deployments/${deployment.id}/status`, { status: 'QUEUED' });
    assert.equal(status, 200);
    assert.equal(body.data.status, 'QUEUED');
    assert.equal(body.data.updated_at, deployment.updated_at);
  });

  test('an unknown deployment is still a 404, not a state machine error', async () => {
    const { status } = await api.patch(`/api/deployments/${MISSING_ID}/status`, { status: 'SUCCESS' });
    assert.equal(status, 404);
  });
});
