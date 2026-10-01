import { recordAudit } from '../services/audit.service.js';
import * as projectService from '../services/project.service.js';
import { sendSuccess } from '../utils/response.js';

export async function listProjects(req, res) {
  const projects = await projectService.listProjects(req.user);
  sendSuccess(res, projects);
}

export async function getProject(req, res) {
  const project = await projectService.getProject(req.user, req.params.id);
  sendSuccess(res, project);
}

export async function createProject(req, res) {
  const project = await projectService.createProject(req.user, req.body);
  await recordAudit({
    req,
    action: 'project.created',
    targetType: 'project',
    targetId: project.id,
    details: { name: project.name, github_repo: project.github_repo, deployment_target: project.deployment_target },
  });
  sendSuccess(res, project, 201);
}

// The audit entry lists the fields that were sent and their new values
// (project settings hold no secrets).
export async function updateProject(req, res) {
  const project = await projectService.updateProject(req.user, req.params.id, req.body);
  await recordAudit({ req, action: 'project.updated', targetType: 'project', targetId: project.id, details: { changes: req.body } });
  sendSuccess(res, project);
}

export async function deleteProject(req, res) {
  const project = await projectService.deleteProject(req.user, req.params.id);
  await recordAudit({ req, action: 'project.deleted', targetType: 'project', targetId: project.id, details: { name: project.name } });
  sendSuccess(res, { id: project.id, deleted: true });
}
