import config from '../config/index.js';
import { ApiError } from '../utils/ApiError.js';
import { recordAudit } from './audit.service.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { createSession, deleteExpiredSessions, deleteSession } from './session.service.js';
import { findUserForSignIn, publicUser, recordSignIn, registerUser, updatePasswordHash } from './user.service.js';

// One message for every failed sign-in, whether the email is unknown, the
// account has no password or the password is wrong.
const INVALID_CREDENTIALS = 'Invalid email or password';

function clientMeta(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

// Returns { user, token } for a new session.
export async function login(req, { email, password }) {
  const account = await findUserForSignIn(email);
  // Always verified (against a dummy hash when there is no account), so the
  // response time does not tell whether the email is registered.
  const valid = await verifyPassword(password, account?.password_hash ?? null);
  if (!account || !valid) {
    await recordAudit({ req, userId: account?.id ?? null, action: 'auth.login_failed', details: { email } });
    throw new ApiError(401, INVALID_CREDENTIALS);
  }

  if (needsRehash(account.password_hash)) {
    await updatePasswordHash(account.id, await hashPassword(password));
  }
  await recordSignIn(account.id);
  await deleteExpiredSessions();
  const token = await createSession(account.id, clientMeta(req));
  await recordAudit({ req, userId: account.id, action: 'auth.login', targetType: 'user', targetId: account.id });
  return { user: publicUser(account), token };
}

// Self-service sign-up (ALLOW_REGISTRATION, off by default in production).
// Returns { user, token }: the new account is signed in at once.
export async function register(req, { name, email, password }) {
  if (!config.auth.allowRegistration) {
    throw new ApiError(403, 'Registration is disabled on this server; ask an administrator for an account');
  }
  const user = await registerUser({ name, email, password });
  const token = await createSession(user.id, clientMeta(req));
  await recordAudit({
    req,
    userId: user.id,
    action: 'auth.register',
    targetType: 'user',
    targetId: user.id,
    details: { role: user.role },
  });
  return { user: publicUser(user), token };
}

export async function logout(req, token) {
  await deleteSession(token);
  if (req.user) {
    await recordAudit({ req, action: 'auth.logout', targetType: 'user', targetId: req.user.id });
  }
}
