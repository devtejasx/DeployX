import { getSystemStatus } from '../services/systemStatus.service.js';

// 200 when every dependency is reachable, 503 when any of them is down.
// Both carry the per-service result in `data` so the dashboard can show it.
export async function getStatus(req, res) {
  const { healthy, status } = await getSystemStatus();

  if (healthy) {
    res.status(200).json({ success: true, data: status });
  } else {
    res.status(503).json({
      success: false,
      data: status,
      error: { message: 'One or more services are unavailable' },
    });
  }
}
