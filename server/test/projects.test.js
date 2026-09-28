import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MISSING_ID, pool, projectPayload, setupTestServer } from './helpers.js';

let api;

before(async () => {
  api = await setupTestServer();
});

after(() => api.close());

describe('POST /api/projects', () => {
  test('creates a project with defaults and a canonical repository URL', async () => {
    const { status, body } = await api.post('/api/projects', {
      name: '  My API  ',
      github_repo: 'https://github.com/example/my-api.git',
      container_port: 8080,
    });

    assert.equal(status, 201);
    assert.equal(body.success, true);
    assert.match(body.data.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.data.name, 'My API');
    assert.equal(body.data.description, null);
    assert.equal(body.data.github_repo, 'https://github.com/example/my-api');
    assert.equal(body.data.github_branch, 'main');
    assert.equal(body.data.dockerfile_path, 'Dockerfile');
    assert.equal(body.data.container_port, 8080);
    assert.equal(body.data.status, 'ACTIVE');
    assert.ok(body.data.user_id);
    assert.ok(body.data.created_at);
  });

  test('rejects a missing name and other invalid fields with readable messages', async () => {
    const { status, body } = await api.post('/api/projects', {
      github_repo: 'https://gitlab.com/example/app',
      github_branch: 'feature..broken',
      dockerfile_path: '../../etc/passwd',
    });

    assert.equal(status, 400);
    assert.equal(body.success, false);
    assert.equal(body.error.message, 'Validation failed');
    assert.deepEqual(body.error.details, [
      'Project name is required',
      'GitHub repository URL must look like https://github.com/<owner>/<repo>',
      'GitHub branch is not a valid git branch name',
      'Dockerfile path must be a relative path inside the repository (no leading "/" or "..")',
      'Container port is required',
    ]);
  });

  test('requires a GitHub repository URL', async () => {
    const { status, body } = await api.post('/api/projects', { name: 'No repo', container_port: 3000 });
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, ['GitHub repository URL is required']);
  });

  test('requires a valid container port instead of guessing one', async () => {
    const missing = await api.post('/api/projects', { ...projectPayload(), container_port: undefined });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body.error.details, ['Container port is required']);

    for (const port of [0, 65536, 80.5, -1]) {
      const { status, body } = await api.post('/api/projects', { ...projectPayload(), container_port: port });
      assert.equal(status, 400, `port ${port} should be rejected`);
      assert.deepEqual(body.error.details, ['Container port must be an integer between 1 and 65535']);
    }

    const asString = await api.post('/api/projects', { ...projectPayload(), container_port: '3000' });
    assert.deepEqual(asString.body.error.details, ['Container port must be a number']);
  });

  test('rejects read-only and unknown fields', async () => {
    const { status, body } = await api.post('/api/projects', {
      ...projectPayload(),
      id: '11111111-1111-4111-8111-111111111111',
      created_at: '2020-01-01T00:00:00Z',
    });
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, ['Unknown or read-only field(s): id, created_at']);
  });

  test('rejects a body that is not a JSON object', async () => {
    const { status, body } = await api.post('/api/projects', ['not', 'an', 'object']);
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, ['Request body must be a JSON object']);
  });

  test('rejects a duplicate project name with 409', async () => {
    const payload = projectPayload();
    assert.equal((await api.post('/api/projects', payload)).status, 201);

    const { status, body } = await api.post('/api/projects', payload);
    assert.equal(status, 409);
    assert.equal(body.error.message, `A project named "${payload.name}" already exists`);
  });
});

describe('GET /api/projects', () => {
  test('lists projects newest first', async () => {
    const first = await api.post('/api/projects', projectPayload());
    const second = await api.post('/api/projects', projectPayload());

    const { status, body } = await api.get('/api/projects');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    const ids = body.data.map((project) => project.id);
    assert.ok(ids.indexOf(second.body.data.id) < ids.indexOf(first.body.data.id));
  });
});

describe('GET /api/projects/:id', () => {
  test('returns one project', async () => {
    const created = await api.post('/api/projects', projectPayload());
    const { status, body } = await api.get(`/api/projects/${created.body.data.id}`);
    assert.equal(status, 200);
    assert.deepEqual(body.data, created.body.data);
  });

  test('returns 404 for a project that does not exist', async () => {
    const { status, body } = await api.get(`/api/projects/${MISSING_ID}`);
    assert.equal(status, 404);
    assert.deepEqual(body, { success: false, error: { message: 'Project not found' } });
  });

  test('returns 400 for a malformed ID', async () => {
    const { status, body } = await api.get('/api/projects/not-a-uuid');
    assert.equal(status, 400);
    assert.deepEqual(body.error.details, ['Invalid project ID']);
  });
});

describe('PUT /api/projects/:id', () => {
  test('updates only the fields that are sent', async () => {
    const created = await api.post('/api/projects', projectPayload({ description: 'Before' }));
    const { id } = created.body.data;

    const { status, body } = await api.put(`/api/projects/${id}`, {
      description: 'After',
      github_branch: 'release/v2',
      container_port: 8081,
      status: 'INACTIVE',
    });

    assert.equal(status, 200);
    assert.equal(body.data.description, 'After');
    assert.equal(body.data.github_branch, 'release/v2');
    assert.equal(body.data.container_port, 8081);
    assert.equal(body.data.status, 'INACTIVE');
    assert.equal(body.data.name, created.body.data.name);
    assert.equal(body.data.created_at, created.body.data.created_at);

    // Compared in PostgreSQL (microsecond precision) rather than JS dates.
    const { rows } = await pool.query('SELECT updated_at > created_at AS touched FROM projects WHERE id = $1', [id]);
    assert.equal(rows[0].touched, true);
  });

  test('clears the description when given an empty string', async () => {
    const created = await api.post('/api/projects', projectPayload({ description: 'Something' }));
    const { body } = await api.put(`/api/projects/${created.body.data.id}`, { description: '' });
    assert.equal(body.data.description, null);
  });

  test('does not allow id, created_at or updated_at to be changed', async () => {
    const created = await api.post('/api/projects', projectPayload());
    const { status, body } = await api.put(`/api/projects/${created.body.data.id}`, {
      id: MISSING_ID,
      updated_at: '2020-01-01T00:00:00Z',
      name: 'Renamed',
    });
    assert.equal(status, 400);
    assert.equal(body.error.details[0], 'Unknown or read-only field(s): id, updated_at');
  });

  test('rejects an empty update and an invalid status', async () => {
    const created = await api.post('/api/projects', projectPayload());
    const { id } = created.body.data;

    const empty = await api.put(`/api/projects/${id}`, {});
    assert.equal(empty.status, 400);
    assert.deepEqual(empty.body.error.details, ['Provide at least one field to update']);

    const badStatus = await api.put(`/api/projects/${id}`, { status: 'PAUSED' });
    assert.equal(badStatus.status, 400);
    assert.deepEqual(badStatus.body.error.details, ['Project status must be one of: ACTIVE, INACTIVE']);
  });

  test('returns 404 for a project that does not exist', async () => {
    const { status } = await api.put(`/api/projects/${MISSING_ID}`, { name: 'Ghost' });
    assert.equal(status, 404);
  });
});

describe('DELETE /api/projects/:id', () => {
  test('deletes the project', async () => {
    const created = await api.post('/api/projects', projectPayload());
    const { id } = created.body.data;

    const { status, body } = await api.delete(`/api/projects/${id}`);
    assert.equal(status, 200);
    assert.deepEqual(body, { success: true, data: { id, deleted: true } });

    assert.equal((await api.get(`/api/projects/${id}`)).status, 404);
    assert.equal((await api.delete(`/api/projects/${id}`)).status, 404);
  });
});
