import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pool, projectPayload, setupTestServer } from './helpers.js';

let api;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

describe('schema', () => {
  test('migrations create the four core tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'pgmigrations'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      rows.map((row) => row.table_name),
      ['deployment_logs', 'deployments', 'projects', 'users'],
    );
  });

  test('the expected indexes exist', async () => {
    const { rows } = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const names = rows.map((row) => row.indexname);
    for (const index of [
      'users_email_key',
      'projects_user_id_name_key',
      'deployments_project_id_created_at_idx',
      'deployment_logs_deployment_id_id_idx',
    ]) {
      assert.ok(names.includes(index), `missing index ${index}`);
    }
  });

  test('foreign keys reject rows that point at nothing', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO deployments (project_id, branch) VALUES (gen_random_uuid(), 'main')`),
      { code: '23503' },
    );
  });

  test('CHECK constraints reject invalid statuses and levels even without the API', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    await assert.rejects(
      pool.query(`INSERT INTO deployments (project_id, branch, status) VALUES ($1, 'main', 'NOPE')`, [project.id]),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query(`UPDATE projects SET status = 'ARCHIVED' WHERE id = $1`, [project.id]),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query(`UPDATE projects SET container_port = 70000 WHERE id = $1`, [project.id]),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO deployments (project_id, branch, container_id) VALUES ($1, 'main', 'not-a-container-id')`,
        [project.id],
      ),
      { code: '23514' },
    );
  });

  test('deployments expose container tracking fields', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;
    for (const field of ['container_id', 'container_name', 'host_port', 'container_removed_at', 'error_message']) {
      assert.ok(field in deployment, `missing ${field}`);
      assert.equal(deployment[field], null);
    }
  });

  test('deleting a project cascades to its deployments and logs', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;
    await api.post(`/api/deployments/${deployment.id}/logs`, { level: 'INFO', message: 'hello' });

    assert.equal((await api.delete(`/api/projects/${project.id}`)).status, 200);

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM deployments WHERE project_id = $1)::int AS deployments,
         (SELECT count(*) FROM deployment_logs WHERE deployment_id = $2)::int AS logs`,
      [project.id, deployment.id],
    );
    assert.deepEqual(rows[0], { deployments: 0, logs: 0 });
  });
});

describe('database errors', () => {
  test('are reported as a generic 500 without leaking internals', async (t) => {
    const secret = 'password authentication failed for user "deployx" at postgres:5432';
    t.mock.method(pool, 'query', async () => {
      throw new Error(secret);
    });
    t.mock.method(console, 'error', () => {});

    const { status, body } = await api.get('/api/projects');

    assert.equal(status, 500);
    assert.deepEqual(body, { success: false, error: { message: 'Internal server error' } });
    assert.ok(!JSON.stringify(body).includes('deployx'));
  });
});
