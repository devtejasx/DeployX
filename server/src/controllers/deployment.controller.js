import { recordAudit } from '../services/audit.service.js';
import * as deploymentService from '../services/deployment.service.js';
import { sendSuccess } from '../utils/response.js';

// Responds as soon as the job is queued: { deployment, jobId }.
export async function createDeployment(req, res) {
  const result = await deploymentService.createDeployment(req.user, req.params.projectId, req.body);
  await recordAudit({
    req,
    action: 'deployment.created',
    targetType: 'deployment',
    targetId: result.deployment.id,
    details: { project_id: req.params.projectId, branch: result.deployment.branch, commit_sha: result.deployment.commit_sha, trigger: 'MANUAL' },
  });
  sendSuccess(res, result, 201);
}

export async function listProjectDeployments(req, res) {
  const deployments = await deploymentService.listProjectDeployments(req.user, req.params.projectId);
  sendSuccess(res, deployments);
}

export async function getDeployment(req, res) {
  const deployment = await deploymentService.getDeployment(req.user, req.params.deploymentId);
  sendSuccess(res, deployment);
}

export async function updateDeploymentStatus(req, res) {
  const { before, after } = await deploymentService.updateDeploymentStatus(
    req.user,
    req.params.deploymentId,
    req.body.status,
  );
  await recordAudit({
    req,
    action: 'deployment.status_changed',
    targetType: 'deployment',
    targetId: after.id,
    details: { from: before.status, to: after.status },
  });
  sendSuccess(res, after);
}
