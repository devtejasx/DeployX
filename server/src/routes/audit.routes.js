import { Router } from 'express';
import { getAuditLogs } from '../controllers/audit.controller.js';
import { validate } from '../middleware/validation.js';
import { listAuditLogsQuery } from '../validators/audit.validators.js';

// Mounted at /api/audit-logs
const router = Router();

router.get('/', validate({ query: listAuditLogsQuery }), getAuditLogs);

export default router;
