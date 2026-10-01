import { listAuditLogs } from '../services/audit.service.js';
import { sendSuccess } from '../utils/response.js';

// GET /api/audit-logs?limit=50&before=<id>: newest first; an ADMIN reads
// every entry, a USER its own.
export async function getAuditLogs(req, res) {
  const entries = await listAuditLogs(req.user, req.validatedQuery);
  sendSuccess(res, entries);
}
