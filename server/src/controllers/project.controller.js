import * as projectService from '../services/project.service.js';
import { sendSuccess } from '../utils/response.js';

export async function listProjects(req, res) {
  const projects = await projectService.listProjects(req.user.id);
  sendSuccess(res, projects);
}

export async function getProject(req, res) {
  const project = await projectService.getProject(req.user.id, req.params.id);
  sendSuccess(res, project);
}

export async function createProject(req, res) {
  const project = await projectService.createProject(req.user.id, req.body);
  sendSuccess(res, project, 201);
}

export async function updateProject(req, res) {
  const project = await projectService.updateProject(req.user.id, req.params.id, req.body);
  sendSuccess(res, project);
}

export async function deleteProject(req, res) {
  const project = await projectService.deleteProject(req.user.id, req.params.id);
  sendSuccess(res, { id: project.id, deleted: true });
}
