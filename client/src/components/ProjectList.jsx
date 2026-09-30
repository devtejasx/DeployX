import { repositoryName } from '../utils/format.js';

export default function ProjectList({ projects, error, loading, selectedId, onSelect }) {
  return (
    <section className="card projects" aria-labelledby="projects-heading">
      <h2 id="projects-heading">Applications</h2>

      {error && <p className="notice notice--error">Could not load applications: {error}</p>}
      {!error && loading && !projects && <p className="muted">Loading…</p>}
      {projects?.length === 0 && (
        <p className="muted">
          No applications yet. Create one with <code>POST /api/projects</code> (see the README).
        </p>
      )}

      <ul className="project-list">
        {projects?.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className={`project-list__item${project.id === selectedId ? ' project-list__item--selected' : ''}`}
              aria-current={project.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(project.id)}
            >
              <span className="project-list__name">
                {project.name}
                {project.deployment_target === 'AWS_ECS' && (
                  <span className="tag tag--aws" title="Deployed to Amazon ECS">
                    AWS
                  </span>
                )}
              </span>
              <span className="project-list__repo">
                {repositoryName(project.github_repo)} · {project.github_branch}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
