import { apiRequest } from './http.js';

// Thin wrappers over the existing REST API (no new endpoints needed).

export function listProjects(options) {
  return apiRequest('/projects', options);
}

// Newest first (the API's order).
export function listProjectDeployments(projectId, options) {
  return apiRequest(`/projects/${projectId}/deployments`, options);
}

export function getDeployment(deploymentId, options) {
  return apiRequest(`/deployments/${deploymentId}`, options);
}

// Queues a new deployment of the project's configured branch head.
export function createDeployment(projectId, body = {}) {
  return apiRequest(`/projects/${projectId}/deployments`, { method: 'POST', body });
}
