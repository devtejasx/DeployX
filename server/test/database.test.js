import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pool, projectPayload, setupTestServer } from './helpers.js';

let api;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

describe('schema', () => {
  test('migrations create the core tables and the state machine table', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'pgmigrations'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      rows.map((row) => row.table_name),
      ['deployment_logs', 'deployment_status_transitions', 'deployments', 'projects', 'users'],
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
      'deployments_stable_idx',
      'deployments_github_push_commit_key',
      'projects_github_repo_lower_idx',
      'projects_aws_ecs_service_key',
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

  test('deployments expose container tracking and rollback fields', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;
    for (const field of [
      'container_id',
      'container_name',
      'host_port',
      'container_removed_at',
      'error_message',
      'health_check',
      'rollback_status',
      'rollback_deployment_id',
    ]) {
      assert.ok(field in deployment, `missing ${field}`);
      assert.equal(deployment[field], null);
    }
    assert.equal(deployment.is_stable, false);
  });

  test('CHECK constraints guard the rollback and health-check columns', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;

    // ROLLING_BACK and ROLLBACK_FAILED are valid statuses.
    for (const status of ['ROLLING_BACK', 'ROLLBACK_FAILED']) {
      await pool.query('INSERT INTO deployments (project_id, branch, status) VALUES ($1, $2, $3)', [
        project.id,
        'main',
        status,
      ]);
    }
    // Health-check details are one JSON object.
    await pool.query(`UPDATE deployments SET health_check = '{"status": "PASSED", "attempts": 1}' WHERE id = $1`, [
      deployment.id,
    ]);
    for (const value of ['[]', '"PASSED"', '3']) {
      await assert.rejects(
        pool.query('UPDATE deployments SET health_check = $2::jsonb WHERE id = $1', [deployment.id, value]),
        { code: '23514' },
        `health_check ${value} should be rejected`,
      );
    }
    await assert.rejects(
      pool.query(`UPDATE deployments SET rollback_status = 'MAYBE' WHERE id = $1`, [deployment.id]),
      { code: '23514' },
    );
    await assert.rejects(
      pool.query('UPDATE deployments SET rollback_deployment_id = gen_random_uuid() WHERE id = $1', [deployment.id]),
      { code: '23503' },
    );
    for (const path of ['health', '//evil.example/health', 'http://evil.example/', '/has space', '']) {
      await assert.rejects(
        pool.query('UPDATE projects SET health_check_path = $2 WHERE id = $1', [project.id, path]),
        { code: '23514' },
        `health_check_path "${path}" should be rejected`,
      );
    }
    await pool.query(`UPDATE projects SET health_check_path = '/api/v1/health?probe=1' WHERE id = $1`, [project.id]);
  });

  test('CHECK constraints guard the deployment target, trigger and AWS columns', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const sha = 'a'.repeat(40);
    const insert = (columns, values) =>
      pool.query(
        `INSERT INTO deployments (project_id, branch, ${columns.join(', ')})
         VALUES ($1, 'main', ${columns.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [project.id, ...values],
      );

    // Existing and new rows default to a manual deployment on the local target.
    const { rows } = await insert(['commit_sha'], ['abc1234']);
    assert.equal(rows[0].trigger, 'MANUAL');
    assert.equal(rows[0].deployment_target, 'LOCAL');
    assert.equal(rows[0].image_digest, null);
    assert.equal(rows[0].aws_task_definition_arn, null);

    await insert(
      ['trigger', 'commit_sha', 'deployment_target', 'image_digest', 'aws_task_definition_arn'],
      ['GITHUB_PUSH', sha, 'AWS_ECS', `sha256:${'0'.repeat(64)}`, 'arn:aws:ecs:eu-west-1:123456789012:task-definition/my-app:7'],
    );
    for (const [columns, values] of [
      [['trigger'], ['CRON']],
      [['deployment_target'], ['EKS']],
      [['image_digest'], ['sha256:abc']],
      [['image_digest'], [`md5:${'0'.repeat(64)}`]],
      [['aws_task_definition_arn'], ['arn:aws:ecs:eu-west-1:123456789012:service/my-app']],
      [['aws_task_definition_arn'], ['my-app:7']],
      // A push deployment is pinned to a full commit SHA.
      [['trigger'], ['GITHUB_PUSH']],
      [['trigger', 'commit_sha'], ['GITHUB_PUSH', 'abc1234']],
    ]) {
      await assert.rejects(insert(columns, values), { code: '23514' }, `${columns} = ${values} should be rejected`);
    }

    // One push deployment per project and commit; manual ones may repeat it.
    await assert.rejects(insert(['trigger', 'commit_sha'], ['GITHUB_PUSH', sha]), {
      code: '23505',
      constraint: 'deployments_github_push_commit_key',
    });
    await insert(['commit_sha'], [sha]);
    await insert(['commit_sha'], [sha]);
    const other = (await api.post('/api/projects', projectPayload())).body.data;
    await pool.query(`INSERT INTO deployments (project_id, branch, trigger, commit_sha) VALUES ($1, 'main', 'GITHUB_PUSH', $2)`, [
      other.id,
      sha,
    ]);
  });

  test('an AWS_ECS project needs its ECS service and URL, and owns the service', async () => {
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const setTarget = (id, service, url) =>
      pool.query(
        `UPDATE projects SET deployment_target = 'AWS_ECS', aws_ecs_service = $2, aws_service_url = $3
         WHERE id = $1 RETURNING deployment_target`,
        [id, service, url],
      );

    const { rows } = await pool.query('SELECT deployment_target FROM projects WHERE id = $1', [project.id]);
    assert.equal(rows[0].deployment_target, 'LOCAL');

    await assert.rejects(setTarget(project.id, null, 'https://app.example.com'), { code: '23514' });
    await assert.rejects(setTarget(project.id, 'my-app', null), { code: '23514' });
    for (const url of [
      'ftp://app.example.com',
      'https://user:pass@app.example.com',
      'https://app.example.com/health',
      'https://app.example.com?x=1',
      'https://App.Example.com',
      'https://',
    ]) {
      await assert.rejects(setTarget(project.id, 'my-app', url), { code: '23514' }, `${url} should be rejected`);
    }
    await assert.rejects(setTarget(project.id, 'my app', 'https://app.example.com'), { code: '23514' });
    await setTarget(project.id, 'my-app_1', 'https://app.example.com:8443');

    // Two projects cannot deploy to the same ECS service.
    const other = (await api.post('/api/projects', projectPayload())).body.data;
    await assert.rejects(setTarget(other.id, 'my-app_1', 'https://other.example.com'), {
      code: '23505',
      constraint: 'projects_aws_ecs_service_key',
    });
    // A LOCAL project may keep an old service name around.
    await pool.query(`UPDATE projects SET aws_ecs_service = 'my-app_1' WHERE id = $1`, [other.id]);
  });

  test('the Phase 7 migration can be reverted and re-applied without losing rows', async () => {
    const { runMigrations } = await import('../src/db/migrate.js');
    const { testDatabaseUrl } = await import('./helpers.js');
    const project = (await api.post('/api/projects', projectPayload())).body.data;
    const { deployment } = (await api.post(`/api/projects/${project.id}/deployments`, {})).body.data;
    const columns = async (table) =>
      (
        await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        )
      ).rows.map((row) => row.column_name);

    await runMigrations({ direction: 'down', count: 1, databaseUrl: testDatabaseUrl, log: () => {} });
    try {
      assert.ok(!(await columns('deployments')).includes('trigger'));
      assert.ok(!(await columns('projects')).includes('deployment_target'));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM deployments WHERE id = $1', [deployment.id])).rows[0].n, 1);
    } finally {
      await runMigrations({ databaseUrl: testDatabaseUrl, log: () => {} });
    }

    const { rows } = await pool.query('SELECT trigger, deployment_target FROM deployments WHERE id = $1', [deployment.id]);
    assert.deepEqual(rows[0], { trigger: 'MANUAL', deployment_target: 'LOCAL' });
    assert.ok((await columns('projects')).includes('aws_service_url'));
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
