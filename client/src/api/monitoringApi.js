import { apiRequest } from './http.js';

// Workers, queue, deployments in progress, recent outcomes, project states
// and active alerts - all read from the real system by the API.
export function fetchMonitoringOverview(options) {
  return apiRequest('/monitoring/overview', options);
}
