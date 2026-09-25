import { Router } from 'express';
import * as projectController from '../controllers/project.controller.js';
import { uuidParams, validate } from '../middleware/validation.js';
import { createProjectSchema, updateProjectSchema } from '../validators/project.validators.js';

const router = Router();
const projectIdParams = uuidParams({ id: 'project' });

router.get('/', projectController.listProjects);
router.post('/', validate({ body: createProjectSchema }), projectController.createProject);
router.get('/:id', validate({ params: projectIdParams }), projectController.getProject);
router.put('/:id', validate({ params: projectIdParams, body: updateProjectSchema }), projectController.updateProject);
router.delete('/:id', validate({ params: projectIdParams }), projectController.deleteProject);

export default router;
