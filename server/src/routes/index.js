import { Router } from 'express';
import { devUser } from '../middleware/devUser.js';
import healthRoutes from './health.routes.js';
import systemRoutes from './system.routes.js';
import projectRoutes from './project.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/system', systemRoutes);

// Resource routes act on behalf of the (temporary) current user.
router.use('/projects', devUser);
router.use('/projects', projectRoutes);

export default router;
