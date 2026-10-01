import { recordAudit } from '../services/audit.service.js';
import * as logService from '../services/log.service.js';
import { sendSuccess } from '../utils/response.js';

export async function addLog(req, res) {
  const log = await logService.addLog(req.user, req.params.deploymentId, req.body);
  await recordAudit({
    req,
    action: 'deployment.log_added',
    targetType: 'deployment',
    targetId: req.params.deploymentId,
    details: { level: log.level, log_id: String(log.id) },
  });
  sendSuccess(res, log, 201);
}

export async function listLogs(req, res) {
  const logs = await logService.listLogs(req.user, req.params.deploymentId);
  sendSuccess(res, logs);
}
