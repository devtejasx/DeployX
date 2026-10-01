import { findSessionUser, sessionCookieName } from '../services/session.service.js';
import { ApiError } from '../utils/ApiError.js';
import { readCookie } from '../utils/cookies.js';

export function sessionToken(req) {
  return readCookie(req.get('cookie'), sessionCookieName());
}

// Sets req.user ({ id, name, email, role, sessionId }) when the request
// carries a valid session cookie. Tokens are only ever read from the cookie:
// never from a URL or query string.
//
// A lookup failure (PostgreSQL unreachable) is kept rather than thrown, so
// public routes such as the system status still answer; requireAuth reports
// it as an internal error.
export async function authenticate(req, res, next) {
  const token = sessionToken(req);
  req.user = null;
  try {
    if (token) req.user = await findSessionUser(token);
  } catch (err) {
    req.authError = err;
  }
  next();
}

// 401 unless the request is signed in.
export function requireAuth(req, res, next) {
  if (req.authError) throw req.authError;
  if (!req.user) throw new ApiError(401, 'Authentication required');
  next();
}

// 403 unless the signed-in user has one of `roles`.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.authError) throw req.authError;
    if (!req.user) throw new ApiError(401, 'Authentication required');
    if (!roles.includes(req.user.role)) throw new ApiError(403, 'You do not have permission to do this');
    next();
  };
}
