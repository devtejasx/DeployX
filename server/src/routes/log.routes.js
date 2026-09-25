import { Router } from 'express';
import * as logController from '../controllers/log.controller.js';
import { uuidParams, validate } from '../middleware/validation.js';
import { createLogSchema } from '../validators/log.validators.js';

// Mounted at /api/deployments/:deploymentId/logs
const router = Router({ mergeParams: true });
const deploymentIdParams = uuidParams({ deploymentId: 'deployment' });

router.post('/', validate({ params: deploymentIdParams, body: createLogSchema }), logController.addLog);
router.get('/', validate({ params: deploymentIdParams }), logController.listLogs);

export default router;
