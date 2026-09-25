import { Router } from 'express';
import * as deploymentController from '../controllers/deployment.controller.js';
import { uuidParams, validate } from '../middleware/validation.js';
import { createDeploymentSchema, updateDeploymentStatusSchema } from '../validators/deployment.validators.js';

// Mounted at /api/projects/:projectId/deployments
export const projectDeploymentRoutes = Router({ mergeParams: true });
const projectIdParams = uuidParams({ projectId: 'project' });

projectDeploymentRoutes.post(
  '/',
  validate({ params: projectIdParams, body: createDeploymentSchema }),
  deploymentController.createDeployment,
);
projectDeploymentRoutes.get('/', validate({ params: projectIdParams }), deploymentController.listProjectDeployments);

// Mounted at /api/deployments
const deploymentRoutes = Router();
const deploymentIdParams = uuidParams({ deploymentId: 'deployment' });

deploymentRoutes.get('/:deploymentId', validate({ params: deploymentIdParams }), deploymentController.getDeployment);
deploymentRoutes.patch(
  '/:deploymentId/status',
  validate({ params: deploymentIdParams, body: updateDeploymentStatusSchema }),
  deploymentController.updateDeploymentStatus,
);

export default deploymentRoutes;
