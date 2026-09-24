import { getSystemStatus } from '../services/systemStatus.service.js';

// 200 when every dependency is reachable, 503 when any of them is down.
// The body always carries the per-service result so the dashboard can show it.
export async function getStatus(req, res, next) {
  try {
    const { healthy, status } = await getSystemStatus();
    res.status(healthy ? 200 : 503).json(status);
  } catch (err) {
    next(err);
  }
}
