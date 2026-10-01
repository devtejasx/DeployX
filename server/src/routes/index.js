import { Router } from 'express';
import { authenticate, requireAuth } from '../middleware/auth.js';
import auditRoutes from './audit.routes.js';
import authRoutes from './auth.routes.js';
import healthRoutes from './health.routes.js';
import systemRoutes from './system.routes.js';
import projectRoutes from './project.routes.js';
import deploymentRoutes, { projectDeploymentRoutes } from './deployment.routes.js';
import logRoutes from './log.routes.js';

const router = Router();

// Liveness: answers without touching PostgreSQL or Redis.
router.use('/health', healthRoutes);

// Everything below knows who is signed in (req.user, or null).
router.use(authenticate);
router.use('/system', systemRoutes);
router.use('/auth', authRoutes);

// Resource routes require a signed-in user. Which projects and deployments
// that user may reach is decided by the services (see services/access.js).
router.use(['/projects', '/deployments', '/audit-logs'], requireAuth);
router.use('/projects', projectRoutes);
router.use('/projects/:projectId/deployments', projectDeploymentRoutes);
router.use('/deployments', deploymentRoutes);
router.use('/deployments/:deploymentId/logs', logRoutes);
router.use('/audit-logs', auditRoutes);

export default router;
