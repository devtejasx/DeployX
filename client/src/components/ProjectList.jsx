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
              <span className="project-list__name">{project.name}</span>
              <span className="project-list__repo">{project.github_repo.replace('https://github.com/', '')}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
