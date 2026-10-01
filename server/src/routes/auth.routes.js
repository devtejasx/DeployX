import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { loginEmailLimiter, loginLimiter, registerLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validation.js';
import { loginSchema, registerSchema } from '../validators/auth.validators.js';

// Mounted at /api/auth
const router = Router();

router.post('/register', registerLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', loginLimiter, loginEmailLimiter, validate({ body: loginSchema }), authController.login);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

export default router;
