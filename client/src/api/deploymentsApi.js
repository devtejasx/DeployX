import { apiRequest } from './http.js';

// Thin wrappers over the existing REST API (no new endpoints needed).

export function listProjects(options) {
  return apiRequest('/projects', options);
}

// Creates an application; resolves with the stored project. Validation errors
// carry the API's messages in err.body.error.details.
export function createProject(fields) {
  return apiRequest('/projects', { method: 'POST', body: fields });
}

// Changes some of a project's settings (repository, branch, deployment
// target...); resolves with the updated project. Validation errors carry the
// API's messages in err.body.error.details.
export function updateProject(projectId, changes) {
  return apiRequest(`/projects/${projectId}`, { method: 'PUT', body: changes });
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
