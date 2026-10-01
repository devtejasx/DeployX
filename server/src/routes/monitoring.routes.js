import { Router } from 'express';
import { overview } from '../controllers/monitoring.controller.js';

// Mounted at /api/monitoring
const router = Router();

router.get('/overview', overview);

export default router;
