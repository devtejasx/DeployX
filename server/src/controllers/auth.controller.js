import { sessionToken } from '../middleware/auth.js';
import * as authService from '../services/auth.service.js';
import { sessionCookieName, sessionCookieOptions } from '../services/session.service.js';
import { sendSuccess } from '../utils/response.js';

function setSessionCookie(res, token) {
  res.cookie(sessionCookieName(), token, sessionCookieOptions());
}

// Responses never contain the token: it only travels in the cookie.
export async function register(req, res) {
  const { user, token } = await authService.register(req, req.body);
  setSessionCookie(res, token);
  sendSuccess(res, { user }, 201);
}

export async function login(req, res) {
  const { user, token } = await authService.login(req, req.body);
  setSessionCookie(res, token);
  sendSuccess(res, { user });
}

export async function logout(req, res) {
  await authService.logout(req, sessionToken(req));
  const { maxAge, ...options } = sessionCookieOptions();
  res.clearCookie(sessionCookieName(), options);
  sendSuccess(res, { signedOut: true });
}

export function me(req, res) {
  const { id, name, email, role } = req.user;
  sendSuccess(res, { user: { id, name, email, role } });
}
