import { Router } from 'express';
import * as logController from '../controllers/log.controller.js';
import * as logStreamController from '../controllers/logStream.controller.js';
import { requireRole } from '../middleware/auth.js';
import { uuidParams, validate } from '../middleware/validation.js';
import { createLogSchema } from '../validators/log.validators.js';

// Mounted at /api/deployments/:deploymentId/logs
const router = Router({ mergeParams: true });
const deploymentIdParams = uuidParams({ deploymentId: 'deployment' });

// Raw log lines: the platform writes logs itself; ADMIN only.
router.post('/', requireRole('ADMIN'), validate({ params: deploymentIdParams, body: createLogSchema }), logController.addLog);
router.get('/', validate({ params: deploymentIdParams }), logController.listLogs);
// Live logs as Server-Sent Events (see controllers/logStream.controller.js).
router.get('/stream', validate({ params: deploymentIdParams }), logStreamController.streamLogs);

export default router;
