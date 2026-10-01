import { getOverview } from '../services/monitoring.service.js';
import { sendSuccess } from '../utils/response.js';

// GET /api/monitoring/overview: workers, queue, deployments in progress,
// recent outcomes, project states and active alerts (see the service).
export async function overview(req, res) {
  sendSuccess(res, await getOverview(req.user));
}
