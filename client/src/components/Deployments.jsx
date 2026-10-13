import { useEffect, useState } from 'react';
import { createDeployment, listProjectDeployments, listProjects } from '../api/deploymentsApi.js';
import { useDeploymentStream } from '../hooks/useDeploymentStream.js';
import { useHashRoute } from '../hooks/useHashRoute.js';
import { usePolling } from '../hooks/usePolling.js';
import { isTerminal } from '../utils/format.js';
import DeploymentDetails from './DeploymentDetails.jsx';
import DeploymentHistory from './DeploymentHistory.jsx';
import NewProject from './NewProject.jsx';
import ProjectList from './ProjectList.jsx';
import ProjectSettings from './ProjectSettings.jsx';

const hasRunningDeployment = (deployments) => deployments?.some((deployment) => !isTerminal(deployment.status));

// Applications -> their deployment history -> one deployment's details.
// All data comes from the API; nothing is kept as a second source of truth.
export default function Deployments() {
  const [{ projectId, deploymentId }, navigate] = useHashRoute();

  const projects = usePolling(() => listProjects(), []);
  const project = projects.data?.find((candidate) => candidate.id === projectId) ?? null;

  // The settings panel of the selected application; closed when another one
  // is selected.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => setSettingsOpen(false), [projectId]);

  // The form that creates an application, in place of the selected one.
  const [newOpen, setNewOpen] = useState(false);

  async function created(newProject) {
    await projects.reload();
    setNewOpen(false);
    navigate(newProject.id);
  }

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

  // Deployments are numbered from the oldest (#1); the API lists newest first.
  function numberOf(id) {
    const index = history.data?.findIndex((deployment) => deployment.id === id) ?? -1;
    return index >= 0 ? history.data.length - index : '';
  }

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
        onSelect={(id) => {
          setNewOpen(false);
          navigate(id);
        }}
        onNew={() => setNewOpen(true)}
      />

      <div className="deployments__main">
        {newOpen && <NewProject onCreated={created} onClose={() => setNewOpen(false)} />}

        {/* With no applications at all, the list itself says how to create one. */}
        {!newOpen && !projectId && projects.data?.length > 0 && (
          <p className="card muted">Select an application to see its deployments.</p>
        )}
        {!newOpen && projectId && projects.data && !project && (
          <p className="card notice notice--error">Application not found.</p>
        )}

        {!newOpen && project && settingsOpen && (
          <ProjectSettings project={project} onSaved={projects.reload} onClose={() => setSettingsOpen(false)} />
        )}

        {!newOpen && project && (
          <DeploymentHistory
            project={project}
            deployments={history.data}
            error={history.error}
            loading={history.loading}
            selectedId={deploymentId}
            onSelect={(id) => navigate(projectId, id)}
            onDeploy={deploy}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        )}

        {!newOpen && project && deploymentId && (
          <DeploymentDetails
            stream={stream}
            project={project}
            number={numberOf(deploymentId)}
            numberOf={numberOf}
            onSelect={(id) => navigate(projectId, id)}
            onClose={() => navigate(projectId)}
          />
        )}
      </div>
    </div>
  );
}
