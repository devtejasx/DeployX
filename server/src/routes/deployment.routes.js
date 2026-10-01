import { Router } from 'express';
import * as deploymentController from '../controllers/deployment.controller.js';
import { requireRole } from '../middleware/auth.js';
import { deploymentLimiter } from '../middleware/rateLimit.js';
import { uuidParams, validate } from '../middleware/validation.js';
import { createDeploymentSchema, updateDeploymentStatusSchema } from '../validators/deployment.validators.js';

// Mounted at /api/projects/:projectId/deployments
export const projectDeploymentRoutes = Router({ mergeParams: true });
const projectIdParams = uuidParams({ projectId: 'project' });

projectDeploymentRoutes.post(
  '/',
  deploymentLimiter,
  validate({ params: projectIdParams, body: createDeploymentSchema }),
  deploymentController.createDeployment,
);
projectDeploymentRoutes.get('/', validate({ params: projectIdParams }), deploymentController.listProjectDeployments);

// Mounted at /api/deployments
const deploymentRoutes = Router();
const deploymentIdParams = uuidParams({ deploymentId: 'deployment' });

deploymentRoutes.get('/:deploymentId', validate({ params: deploymentIdParams }), deploymentController.getDeployment);
// Manual status override: an operator tool, ADMIN only.
deploymentRoutes.patch(
  '/:deploymentId/status',
  requireRole('ADMIN'),
  validate({ params: deploymentIdParams, body: updateDeploymentStatusSchema }),
  deploymentController.updateDeploymentStatus,
);

export default deploymentRoutes;
