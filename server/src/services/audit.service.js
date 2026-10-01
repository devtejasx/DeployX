import { query } from '../db/postgres.js';
import { logger } from '../lib/logger.js';

// Audit log of security-sensitive actions (table audit_logs).
//
// Actions are "<area>.<verb>": auth.login, auth.login_failed, auth.logout,
// auth.register, project.created, project.updated, project.deleted,
// deployment.created, deployment.status_changed, deployment.log_added,
// webhook.push, access.denied. `details` is a small object of non-secret
// facts (changed field names and values, the trigger, a reason); callers
// never pass passwords, tokens, signatures or keys.
//
// Recording is best effort: an audit failure is logged but does not fail the
// action it describes (the database is usually what failed, and the action
// itself will then fail too).

const MAX_DETAIL_LENGTH = 4000;

function requestMeta(req) {
  if (!req) return { ip: null, requestId: null };
  return { ip: typeof req.ip === 'string' ? req.ip.slice(0, 45) : null, requestId: req.id ?? null };
}

export async function recordAudit({ req = null, userId = req?.user?.id ?? null, action, targetType = null, targetId = null, details = {} }) {
  const { ip, requestId } = requestMeta(req);
  let json = JSON.stringify(details ?? {});
  if (json.length > MAX_DETAIL_LENGTH) json = JSON.stringify({ truncated: true });
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, ip, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [userId, action, targetType, targetId === null ? null : String(targetId), ip, requestId, json],
    );
  } catch (err) {
    logger.error('audit_record_failed', { action, err });
  }
}

// Newest first. ADMIN reads every entry, a USER only its own. `before` is an
// entry id for paging; at most `limit` entries.
export async function listAuditLogs(user, { limit = 50, before = null } = {}) {
  const { rows } = await query(
    `SELECT a.id::text AS id, a.user_id, u.email AS user_email, a.action, a.target_type, a.target_id,
            a.ip, a.request_id, a.details, a.created_at
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::boolean OR a.user_id = $2)
       AND ($3::bigint IS NULL OR a.id < $3::bigint)
     ORDER BY a.id DESC
     LIMIT $4`,
    [user.role === 'ADMIN', user.id, before, limit],
  );
  return rows;
}
