import crypto from 'node:crypto';
import config from '../config/index.js';
import { query } from '../db/postgres.js';
import { logger } from '../lib/logger.js';

// Server-side sessions (table `sessions`).
//
// The browser gets a random 256-bit token in an HttpOnly, SameSite=Strict
// cookie (Secure in production): JavaScript cannot read it, other sites
// cannot send it, and it never appears in a URL. PostgreSQL stores only its
// SHA-256, so the token cannot be recovered from the database. A session ends
// after SESSION_TTL_HOURS whatever happens, after
// SESSION_IDLE_TIMEOUT_MINUTES without a request, on sign-out, or when its
// user is deleted.

// How often a session's last_seen_at is refreshed (not on every request).
const TOUCH_INTERVAL_MS = 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sessionCookieName() {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
  // host-only and for path "/" - it cannot be set by a sibling subdomain.
  return config.auth.cookieSecure ? '__Host-deployx_session' : 'deployx_session';
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.auth.sessionTtlHours * 60 * 60 * 1000,
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest();
}

function clip(value, max) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

// Starts a session for the user; returns the token for the cookie.
export async function createSession(userId, { ip, userAgent } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [userId, hashToken(token), clip(ip, 45), clip(userAgent, 255), config.auth.sessionTtlHours],
  );
  return token;
}

// The signed-in user of a session token ({ id, name, email, role, sessionId }),
// or null when the token is unknown, expired or idle for too long.
export async function findSessionUser(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.name, u.email, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND s.last_seen_at > now() - make_interval(mins => $2)
       AND u.password_hash IS NOT NULL`,
    [hashToken(token), config.auth.idleTimeoutMinutes],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role, sessionId: row.session_id };
}

export async function deleteSession(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

// Ends every session of a user (e.g. after a password change).
export async function deleteUserSessions(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// Sessions past their lifetime or idle timeout are removed when their user
// signs in again; this also bounds the table for users who never come back.
export async function deleteExpiredSessions() {
  const { rowCount } = await query(
    `DELETE FROM sessions WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(mins => $1)`,
    [config.auth.idleTimeoutMinutes],
  );
  return rowCount;
}

// Runs deleteExpiredSessions() every `intervalMs` (and once now), so the
// table stays small even for users who never sign in again. Returns { stop }.
export function startSessionCleanup(intervalMs = config.auth.sessionCleanupIntervalMs) {
  async function run() {
    try {
      const removed = await deleteExpiredSessions();
      if (removed > 0) logger.info('sessions_cleaned', { removed });
    } catch (err) {
      logger.warn('session_cleanup_failed', { err });
    }
  }
  const timer = setInterval(run, intervalMs);
  timer.unref();
  run();
  return { stop: () => clearInterval(timer), run };
}
