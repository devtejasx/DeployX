import { sendSuccess } from '../utils/response.js';

export function getHealth(req, res) {
  sendSuccess(res, {
    status: 'ok',
    service: 'deployx-api',
    timestamp: new Date().toISOString(),
  });
}
