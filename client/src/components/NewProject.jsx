import { useState } from 'react';
import { createProject } from '../api/deploymentsApi.js';

const EMPTY_FORM = {
  name: '',
  github_repo: '',
  github_branch: 'main',
  dockerfile_path: 'Dockerfile',
  container_port: '',
  health_check_path: '/health',
};

// Creates an application with POST /api/projects. The API validates every
// field and its messages are shown as they are. New applications deploy to
// the local Docker host; the AWS ECS target is chosen afterwards in Settings,
// once the application has an ECS service.
export default function NewProject({ onCreated, onClose }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState(null);

  function change(field) {
    return (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  async function create(event) {
    event.preventDefault();
    setSaving(true);
    setErrors(null);
    try {
      const project = await createProject({
        name: form.name,
        github_repo: form.github_repo,
        github_branch: form.github_branch,
        dockerfile_path: form.dockerfile_path,
        // An empty or non-numeric port is sent as it is, so the API names the problem.
        container_port: form.container_port === '' ? undefined : Number(form.container_port),
        health_check_path: form.health_check_path,
      });
      setSaving(false);
      await onCreated(project);
    } catch (err) {
      setErrors(err.body?.error?.details ?? [err.message]);
      setSaving(false);
    }
  }

  return (
    <section className="card settings" aria-labelledby="new-project-heading">
      <div className="card__header">
        <h2 id="new-project-heading">New application</h2>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>

      <form className="settings__form" onSubmit={create}>
        <fieldset>
          <legend>Application</legend>
          <label>
            <span>Name</span>
            <input value={form.name} onChange={change('name')} placeholder="my-app" required maxLength={100} autoFocus />
          </label>
        </fieldset>

        <fieldset>
          <legend>Repository</legend>
          <label>
            <span>Repository URL</span>
            <input
              type="url"
              value={form.github_repo}
              onChange={change('github_repo')}
              placeholder="https://github.com/owner/repo"
              required
            />
          </label>
          <label>
            <span>Branch</span>
            <input value={form.github_branch} onChange={change('github_branch')} placeholder="main" required />
          </label>
          <label>
            <span>Dockerfile path</span>
            <input value={form.dockerfile_path} onChange={change('dockerfile_path')} placeholder="Dockerfile" required />
          </label>
          <p className="settings__hint muted">
            Relative to the repository root, which is also the build context. To try DeployX, use{' '}
            <code>https://github.com/devtejasx/DeployX</code> with <code>examples/hello-app/Dockerfile</code>.
          </p>
        </fieldset>

        <fieldset>
          <legend>Runtime</legend>
          <label>
            <span>Container port</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.container_port}
              onChange={change('container_port')}
              placeholder="3000"
              required
            />
          </label>
          <label>
            <span>Health-check path</span>
            <input value={form.health_check_path} onChange={change('health_check_path')} placeholder="/health" required />
          </label>
          <p className="settings__hint muted">
            The port the app listens on inside its container. A deployment becomes <code>SUCCESS</code> only when this
            path answers with a 2xx status; otherwise the last stable version is restored.
          </p>
        </fieldset>

        {errors && (
          <div className="notice notice--error" role="alert">
            <strong>Could not create the application</strong>
            <ul className="settings__errors">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="settings__actions">
          <button type="submit" className="button--primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create application'}
          </button>
        </div>
      </form>
    </section>
  );
}
