// The deployment state machine is enforced by PostgreSQL itself
// (migration 1790671094193_deployment-state-machine): these tests exercise
// transition_deployment_status() and the trigger directly.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pool, projectPayload, setupTestServer } from './helpers.js';

let api;
let projectId;

before(async () => {
  api = await setupTestServer();
  projectId = (await api.post('/api/projects', projectPayload())).body.data.id;
});

after(() => api.close());

// A deployment row forced into `status` (setup only: bypasses the trigger).
async function deploymentIn(status) {
  const { rows } = await pool.query(
    `INSERT INTO deployments (project_id, branch, status) VALUES ($1, 'main', $2) RETURNING id`,
    [projectId, status],
  );
  return rows[0].id;
}

async function transition(id, status, errorMessage = null) {
  const { rows } = await pool.query('SELECT * FROM transition_deployment_status($1, $2, $3)', [id, status, errorMessage]);
  return rows[0];
}

describe('allowed transitions', () => {
  for (const [from, to] of [
    ['QUEUED', 'BUILDING'],
    ['BUILDING', 'DEPLOYING'],
    ['DEPLOYING', 'SUCCESS'],
    ['QUEUED', 'FAILED'],
    ['BUILDING', 'FAILED'],
    ['DEPLOYING', 'FAILED'],
    // A failed attempt goes back to QUEUED while BullMQ waits to retry.
    ['BUILDING', 'QUEUED'],
    ['DEPLOYING', 'QUEUED'],
  ]) {
    test(`${from} -> ${to} passes`, async () => {
      const id = await deploymentIn(from);
      const updated = await transition(id, to);
      assert.equal(updated.status, to);
    });
  }
});

describe('rejected transitions', () => {
  for (const [from, to] of [
    ['SUCCESS', 'BUILDING'],
    ['FAILED', 'DEPLOYING'],
    ['SUCCESS', 'QUEUED'],
    ['SUCCESS', 'FAILED'],
    ['FAILED', 'SUCCESS'],
    ['QUEUED', 'SUCCESS'],
    ['QUEUED', 'DEPLOYING'],
    ['BUILDING', 'SUCCESS'],
  ]) {
    test(`${from} -> ${to} fails and leaves the deployment unchanged`, async () => {
      const id = await deploymentIn(from);
      await assert.rejects(transition(id, to), (err) => {
        assert.equal(err.code, 'DX001');
        assert.deepEqual(JSON.parse(err.detail), { from, to });
        return true;
      });
      const { rows } = await pool.query('SELECT status FROM deployments WHERE id = $1', [id]);
      assert.equal(rows[0].status, from);
    });
  }

  test('the trigger also blocks direct UPDATEs that bypass the function', async () => {
    const id = await deploymentIn('SUCCESS');
    await assert.rejects(pool.query(`UPDATE deployments SET status = 'BUILDING' WHERE id = $1`, [id]), {
      code: 'DX001',
    });
  });
});

describe('transition_deployment_status()', () => {
  test('keeps timestamps and the error message consistent with the status', async () => {
    const id = await deploymentIn('QUEUED');

    const building = await transition(id, 'BUILDING');
    assert.ok(building.started_at);
    assert.equal(building.finished_at, null);

    // Retry: back to QUEUED keeps started_at from the first attempt.
    const retrying = await transition(id, 'QUEUED');
    assert.deepEqual(retrying.started_at, building.started_at);

    await transition(id, 'BUILDING');
    const failed = await transition(id, 'FAILED', 'Docker build failed');
    assert.ok(failed.finished_at);
    assert.equal(failed.error_message, 'Docker build failed');
    assert.deepEqual(failed.started_at, building.started_at);
  });

  test('setting the current status again is a no-op, and unknown deployments return nothing', async () => {
    const id = await deploymentIn('FAILED');
    const { rows: before } = await pool.query('SELECT * FROM deployments WHERE id = $1', [id]);
    const same = await transition(id, 'FAILED', 'ignored');
    assert.deepEqual(same, before[0]);

    assert.equal(await transition('00000000-0000-4000-8000-000000000000', 'BUILDING'), undefined);
  });

  test('the transition map is stored in one table', async () => {
    const { rows } = await pool.query(
      `SELECT from_status, array_agg(to_status ORDER BY to_status) AS targets
       FROM deployment_status_transitions GROUP BY from_status ORDER BY from_status`,
    );
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.from_status, row.targets])), {
      BUILDING: ['DEPLOYING', 'FAILED', 'QUEUED'],
      DEPLOYING: ['FAILED', 'HEALTH_CHECK', 'QUEUED', 'SUCCESS'],
      HEALTH_CHECK: ['FAILED', 'QUEUED', 'SUCCESS'],
      QUEUED: ['BUILDING', 'FAILED'],
    });
  });
});
