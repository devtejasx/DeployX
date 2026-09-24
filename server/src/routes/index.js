import { Router } from 'express';
import healthRoutes from './health.routes.js';
import systemRoutes from './system.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/system', systemRoutes);

export default router;
