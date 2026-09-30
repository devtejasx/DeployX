import { useEffect, useState } from 'react';
import { updateProject } from '../api/deploymentsApi.js';
import { repositoryName } from '../utils/format.js';

function formFrom(project) {
  return {
    github_repo: project.github_repo,
    github_branch: project.github_branch,
    deployment_target: project.deployment_target,
    aws_ecs_service: project.aws_ecs_service ?? '',
    aws_service_url: project.aws_service_url ?? '',
  };
}

// An application's repository, branch and deployment target, saved with
// PUT /api/projects/:id. The API validates everything and its messages are
// shown as they are; nothing is kept here once it is saved. No secret (the
// webhook secret, GitHub or AWS credentials) ever reaches the browser.
export default function ProjectSettings({ project, onSaved, onClose }) {
  const [form, setForm] = useState(() => formFrom(project));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState(null);
  const [saved, setSaved] = useState(false);

  // The form shows what the API stored (e.g. the normalized service URL)
  // whenever the project is reloaded; messages belong to one application.
  useEffect(() => {
    setForm(formFrom(project));
  }, [project]);
  useEffect(() => {
    setErrors(null);
    setSaved(false);
  }, [project.id]);

  const aws = form.deployment_target === 'AWS_ECS';
  const webhookUrl = `${window.location.origin}/api/webhooks/github`;

  function change(field) {
    return (event) => {
      setForm((current) => ({ ...current, [field]: event.target.value }));
      setSaved(false);
    };
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setErrors(null);
    try {
      const updated = await updateProject(project.id, {
        github_repo: form.github_repo,
        github_branch: form.github_branch,
        deployment_target: form.deployment_target,
        aws_ecs_service: form.aws_ecs_service.trim() || null,
        aws_service_url: form.aws_service_url.trim() || null,
      });
      await onSaved(updated);
      setSaved(true);
    } catch (err) {
      setErrors(err.body?.error?.details ?? [err.message]);
    }
    setSaving(false);
  }

  return (
    <section className="card settings" aria-labelledby="settings-heading">
      <div className="card__header">
        <h2 id="settings-heading">Settings · {project.name}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <form className="settings__form" onSubmit={save}>
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
          <p className="settings__hint muted">
            Owner <code>{repositoryName(project.github_repo).split('/')[0]}</code> · repository{' '}
            <code>{repositoryName(project.github_repo).split('/')[1]}</code>. Pushes to this branch are deployed
            automatically, each at its exact commit.
          </p>
        </fieldset>

        <fieldset>
          <legend>Deployment target</legend>
          <label>
            <span>Target</span>
            <select value={form.deployment_target} onChange={change('deployment_target')}>
              <option value="LOCAL">Local Docker (the worker's Docker host)</option>
              <option value="AWS_ECS">AWS ECS (image in ECR, service on ECS/Fargate)</option>
            </select>
          </label>
          {aws && (
            <>
              <label>
                <span>ECS service</span>
                <input value={form.aws_ecs_service} onChange={change('aws_ecs_service')} placeholder="my-app" required />
              </label>
              <label>
                <span>Service URL</span>
                <input
                  type="url"
                  value={form.aws_service_url}
                  onChange={change('aws_service_url')}
                  placeholder="https://my-app.example.com"
                  required
                />
              </label>
              <p className="settings__hint muted">
                The service must already exist in the worker's ECS cluster. Each deployment pushes the image to ECR,
                updates this service to it, and checks <code>{project.health_check_path}</code> on the service URL.
              </p>
            </>
          )}
        </fieldset>

        {errors && (
          <div className="notice notice--error" role="alert">
            <strong>Could not save</strong>
            <ul className="settings__errors">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        {saved && !errors && (
          <p className="notice notice--ok" role="status">
            Saved. New deployments use these settings.
          </p>
        )}

        <div className="settings__actions">
          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <h3>GitHub webhook</h3>
      <dl className="details__grid settings__webhook">
        <div className="field">
          <dt>Payload URL</dt>
          <dd className="mono">{webhookUrl}</dd>
        </div>
        <div className="field">
          <dt>Content type</dt>
          <dd className="mono">application/json</dd>
        </div>
        <div className="field">
          <dt>Events</dt>
          <dd>Just the push event</dd>
        </div>
        <div className="field">
          <dt>Secret</dt>
          <dd>
            The server's <code>GITHUB_WEBHOOK_SECRET</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}
