import { useEffect } from 'react';
import { createDeployment, listProjectDeployments, listProjects } from '../api/deploymentsApi.js';
import { useDeploymentStream } from '../hooks/useDeploymentStream.js';
import { useHashRoute } from '../hooks/useHashRoute.js';
import { usePolling } from '../hooks/usePolling.js';
import { isTerminal } from '../utils/format.js';
import DeploymentDetails from './DeploymentDetails.jsx';
import DeploymentHistory from './DeploymentHistory.jsx';
import ProjectList from './ProjectList.jsx';

const hasRunningDeployment = (deployments) => deployments?.some((deployment) => !isTerminal(deployment.status));

// Applications -> their deployment history -> one deployment's details.
// All data comes from the API; nothing is kept as a second source of truth.
export default function Deployments() {
  const [{ projectId, deploymentId }, navigate] = useHashRoute();

  const projects = usePolling(() => listProjects(), []);
  const project = projects.data?.find((candidate) => candidate.id === projectId) ?? null;

  // Refreshed every few seconds while any deployment is still running.
  const history = usePolling(() => (projectId ? listProjectDeployments(projectId) : Promise.resolve(null)), [projectId], {
    shouldPoll: hasRunningDeployment,
  });

  // The selected deployment and its logs, live over Server-Sent Events.
  const stream = useDeploymentStream(deploymentId);

  // When the selected deployment changes status, refresh the history row now
  // rather than at the next poll (the API stays the source of truth).
  const streamedStatus = stream.deployment?.status;
  const { reload: reloadHistory } = history;
  useEffect(() => {
    if (streamedStatus) reloadHistory();
  }, [streamedStatus, reloadHistory]);

  const index = history.data?.findIndex((deployment) => deployment.id === deploymentId) ?? -1;
  const number = index >= 0 ? history.data.length - index : '';

  async function deploy() {
    const { deployment } = await createDeployment(projectId);
    await history.reload();
    navigate(projectId, deployment.id);
  }

  return (
    <div className="deployments">
      <ProjectList
        projects={projects.data}
        error={projects.error}
        loading={projects.loading}
        selectedId={projectId}
        onSelect={(id) => navigate(id)}
      />

      <div className="deployments__main">
        {!projectId && <p className="card muted">Select an application to see its deployments.</p>}
        {projectId && projects.data && !project && (
          <p className="card notice notice--error">Application not found.</p>
        )}

        {project && (
          <DeploymentHistory
            project={project}
            deployments={history.data}
            error={history.error}
            loading={history.loading}
            selectedId={deploymentId}
            onSelect={(id) => navigate(projectId, id)}
            onDeploy={deploy}
          />
        )}

        {project && deploymentId && (
          <DeploymentDetails stream={stream} number={number} onClose={() => navigate(projectId)} />
        )}
      </div>
    </div>
  );
}
