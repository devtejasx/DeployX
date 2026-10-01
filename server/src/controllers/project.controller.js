import { recordAudit } from '../services/audit.service.js';
import * as projectService from '../services/project.service.js';
import { sendSuccess } from '../utils/response.js';

// Settings whose change gets its own audit entry, besides project.updated:
// where the code comes from, and where it is deployed.
const GITHUB_FIELDS = ['github_repo', 'github_branch'];
const AWS_FIELDS = ['deployment_target', 'aws_ecs_service', 'aws_service_url'];

// { field: { from, to } } for the fields of `fields` whose value changed.
function changed(before, after, fields) {
  const result = {};
  for (const field of fields) {
    if (before[field] !== after[field]) result[field] = { from: before[field], to: after[field] };
  }
  return result;
}

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

// project.updated lists the fields that were sent and their new values
// (project settings hold no secrets). A change of the GitHub repository or
// branch, or of the deployment target / AWS settings, is also recorded on
// its own with the old and new values: project.github_changed,
// project.aws_changed.
export async function updateProject(req, res) {
  const { before, after: project } = await projectService.updateProject(req.user, req.params.id, req.body);
  const target = { req, targetType: 'project', targetId: project.id };
  await recordAudit({ ...target, action: 'project.updated', details: { changes: req.body } });
  const github = changed(before, project, GITHUB_FIELDS);
  if (Object.keys(github).length > 0) await recordAudit({ ...target, action: 'project.github_changed', details: github });
  const aws = changed(before, project, AWS_FIELDS);
  if (Object.keys(aws).length > 0) await recordAudit({ ...target, action: 'project.aws_changed', details: aws });
  sendSuccess(res, project);
}

export async function deleteProject(req, res) {
  const project = await projectService.deleteProject(req.user, req.params.id);
  await recordAudit({ req, action: 'project.deleted', targetType: 'project', targetId: project.id, details: { name: project.name } });
  sendSuccess(res, { id: project.id, deleted: true });
}
