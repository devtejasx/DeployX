// Stable deployment tracking. "Stable" is derived by PostgreSQL
// (stable_deployment_id() in migration 1790767006154): the last stable
// deployment of a project is its most recently finished SUCCESS deployment.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pool, projectPayload, setupTestServer } from './helpers.js';

let api;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

async function createProject() {
  return (await api.post('/api/projects', projectPayload())).body.data;
}

async function createDeployment(project) {
  return (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data.deployment;
}

// Walks a deployment through the state machine, as the worker would.
async function finish(deployment, ...statuses) {
  for (const status of statuses) {
    const { rows } = await pool.query('SELECT status FROM transition_deployment_status($1, $2, $3)', [
      deployment.id,
      status,
      status === 'FAILED' ? 'failed in a test' : null,
    ]);
    assert.equal(rows[0].status, status);
  }
}
const HEALTHY = ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS'];
const UNHEALTHY = ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'FAILED'];
const ROLLED_BACK = ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK', 'FAILED'];
const ROLLBACK_FAILED = ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK', 'ROLLBACK_FAILED'];

async function stableId(project) {
  const { rows } = await pool.query('SELECT stable_deployment_id($1) AS id', [project.id]);
  return rows[0].id;
}

async function history(project) {
  const { body } = await api.get(`/api/projects/${project.id}/deployments`);
  return body.data;
}

describe('stable_deployment_id()', () => {
  test('a project without a successful deployment has no stable deployment', async () => {
    const project = await createProject();
    assert.equal(await stableId(project), null);

    const queued = await createDeployment(project);
    const failed = await createDeployment(project);
    await finish(failed, ...UNHEALTHY);
    const checking = await createDeployment(project);
    await finish(checking, 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK');

    assert.equal(await stableId(project), null);
    assert.ok((await history(project)).every((deployment) => deployment.is_stable === false));
    assert.equal(queued.is_stable, false);
  });

  test('a deployment becomes stable when it succeeds, replacing the previous stable one', async () => {
    const project = await createProject();
    const first = await createDeployment(project);
    await finish(first, ...HEALTHY);
    assert.equal(await stableId(project), first.id);

    const second = await createDeployment(project);
    await finish(second, 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK');
    // Still being verified: the first one remains the stable deployment.
    assert.equal(await stableId(project), first.id);

    await finish(second, 'SUCCESS');
    assert.equal(await stableId(project), second.id);

    // The previous one is no longer current, but its record is untouched.
    const rows = await history(project);
    assert.deepEqual(
      rows.map(({ id, status, is_stable: isStable }) => ({ id, status, isStable })),
      [
        { id: second.id, status: 'SUCCESS', isStable: true },
        { id: first.id, status: 'SUCCESS', isStable: false },
      ],
    );
    const { body } = await api.get(`/api/deployments/${second.id}`);
    assert.equal(body.data.is_stable, true);
    assert.equal((await api.get(`/api/deployments/${first.id}`)).body.data.is_stable, false);
  });

  test('failed and rolled-back deployments never become stable', async () => {
    const project = await createProject();
    const stable = await createDeployment(project);
    await finish(stable, ...HEALTHY);

    const unhealthy = await createDeployment(project);
    await finish(unhealthy, ...UNHEALTHY);
    const rolledBack = await createDeployment(project);
    await finish(rolledBack, ...ROLLED_BACK);
    const rollbackFailed = await createDeployment(project);
    await finish(rollbackFailed, ...ROLLBACK_FAILED);
    const buildFailure = await createDeployment(project);
    await finish(buildFailure, 'BUILDING', 'FAILED');

    assert.equal(await stableId(project), stable.id);
    const rows = await history(project);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.filter((deployment) => deployment.is_stable).map((deployment) => deployment.id), [stable.id]);
  });

  test('the most recently finished success wins, whatever the creation order', async () => {
    const project = await createProject();
    const older = await createDeployment(project);
    const newer = await createDeployment(project);
    // The newer deployment finishes first, the older one afterwards.
    await finish(newer, ...HEALTHY);
    await finish(older, ...HEALTHY);
    assert.equal(await stableId(project), older.id);
  });

  test('stable deployments are tracked per project', async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const a = await createDeployment(projectA);
    await finish(a, ...HEALTHY);
    assert.equal(await stableId(projectB), null);

    const b = await createDeployment(projectB);
    await finish(b, ...HEALTHY);
    const aFailed = await createDeployment(projectA);
    await finish(aFailed, ...UNHEALTHY);

    assert.equal(await stableId(projectA), a.id);
    assert.equal(await stableId(projectB), b.id);
    assert.equal(await stableId('00000000-0000-4000-8000-000000000000'), null);
  });
});

describe('rollback fields on a deployment', () => {
  test('the API reports the rollback outcome and the restored deployment', async () => {
    const project = await createProject();
    const stable = await createDeployment(project);
    await finish(stable, ...HEALTHY);
    const failed = await createDeployment(project);
    await finish(failed, 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK');
    await pool.query(
      `UPDATE deployments SET rollback_status = 'COMPLETED', rollback_deployment_id = $2 WHERE id = $1`,
      [failed.id, stable.id],
    );
    await finish(failed, 'FAILED');

    const { body } = await api.get(`/api/deployments/${failed.id}`);
    assert.equal(body.data.status, 'FAILED');
    assert.equal(body.data.rollback_status, 'COMPLETED');
    assert.equal(body.data.rollback_deployment_id, stable.id);
    assert.equal(body.data.is_stable, false);
    assert.equal((await api.get(`/api/deployments/${stable.id}`)).body.data.is_stable, true);
  });

  test('ROLLING_BACK can be reached through the API only from HEALTH_CHECK', async () => {
    const project = await createProject();
    const deployment = await createDeployment(project);
    const patch = (status) => api.patch(`/api/deployments/${deployment.id}/status`, { status });

    const early = await patch('ROLLING_BACK');
    assert.equal(early.status, 409);
    assert.deepEqual(early.body.error, {
      message: 'Invalid deployment state transition',
      from: 'QUEUED',
      to: 'ROLLING_BACK',
    });

    for (const status of ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK']) {
      assert.equal((await patch(status)).status, 200, status);
    }
    assert.equal((await patch('SUCCESS')).status, 409);
    const failed = await patch('FAILED');
    assert.equal(failed.body.data.status, 'FAILED');
    assert.ok(failed.body.data.finished_at);
  });

  test('ROLLBACK_FAILED can be reached only from ROLLING_BACK, and is final', async () => {
    const project = await createProject();
    const deployment = await createDeployment(project);
    const patch = (status) => api.patch(`/api/deployments/${deployment.id}/status`, { status });

    for (const status of ['BUILDING', 'DEPLOYING', 'HEALTH_CHECK']) await patch(status);
    const tooEarly = await patch('ROLLBACK_FAILED');
    assert.equal(tooEarly.status, 409);
    assert.deepEqual(tooEarly.body.error, {
      message: 'Invalid deployment state transition',
      from: 'HEALTH_CHECK',
      to: 'ROLLBACK_FAILED',
    });

    await patch('ROLLING_BACK');
    const failed = await patch('ROLLBACK_FAILED');
    assert.equal(failed.status, 200);
    assert.equal(failed.body.data.status, 'ROLLBACK_FAILED');
    assert.ok(failed.body.data.finished_at);
    assert.equal(failed.body.data.is_stable, false);

    for (const status of ['FAILED', 'SUCCESS', 'ROLLING_BACK', 'QUEUED']) {
      assert.equal((await patch(status)).status, 409, `ROLLBACK_FAILED -> ${status}`);
    }
  });

  test('the API returns the health-check details recorded for a deployment', async () => {
    const project = await createProject();
    const deployment = await createDeployment(project);
    assert.equal(deployment.health_check, null);

    const details = { status: 'PASSED', attempts: 2, max_attempts: 5, status_code: 200, response_time: 38, error: null };
    await pool.query('UPDATE deployments SET health_check = $2 WHERE id = $1', [deployment.id, details]);

    assert.deepEqual((await api.get(`/api/deployments/${deployment.id}`)).body.data.health_check, details);
    const [listed] = await history(project);
    assert.deepEqual(listed.health_check, details);
  });
});
