import * as deploymentService from '../services/deployment.service.js';
import { sendSuccess } from '../utils/response.js';

export async function createDeployment(req, res) {
  const deployment = await deploymentService.createDeployment(req.user.id, req.params.projectId, req.body);
  sendSuccess(res, deployment, 201);
}

export async function listProjectDeployments(req, res) {
  const deployments = await deploymentService.listProjectDeployments(req.user.id, req.params.projectId);
  sendSuccess(res, deployments);
}

export async function getDeployment(req, res) {
  const deployment = await deploymentService.getDeployment(req.user.id, req.params.deploymentId);
  sendSuccess(res, deployment);
}

export async function updateDeploymentStatus(req, res) {
  const deployment = await deploymentService.updateDeploymentStatus(
    req.user.id,
    req.params.deploymentId,
    req.body.status,
  );
  sendSuccess(res, deployment);
}
