import * as logService from '../services/log.service.js';
import { sendSuccess } from '../utils/response.js';

export async function addLog(req, res) {
  const log = await logService.addLog(req.user.id, req.params.deploymentId, req.body);
  sendSuccess(res, log, 201);
}

export async function listLogs(req, res) {
  const logs = await logService.listLogs(req.user.id, req.params.deploymentId);
  sendSuccess(res, logs);
}
