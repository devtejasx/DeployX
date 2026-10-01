import { query, withTransaction } from '../db/postgres.js';
import { ApiError } from '../utils/ApiError.js';
import { hashPassword } from './password.js';

// What the API ever returns about a user: never the password hash.
export const USER_COLUMNS = 'id, name, email, role, last_login_at, created_at, updated_at';

export function publicUser(user) {
  const { id, name, email, role, last_login_at: lastLoginAt = null, created_at: createdAt } = user;
  return { id, name, email, role, last_login_at: lastLoginAt, created_at: createdAt };
}

// The user with this (lower-case) email including its password hash, for
// signing in only; null if there is none.
export async function findUserForSignIn(email) {
  const { rows } = await query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1`, [email]);
  return rows[0] ?? null;
}

// Creates an account. The first account while no ADMIN exists becomes the
// ADMIN (bootstrapping a fresh installation); every later one is a USER.
// Serialized with an advisory lock, so two simultaneous sign-ups cannot both
// become ADMIN. 409 if the email is taken.
export async function registerUser({ name, email, password }) {
  const passwordHash = await hashPassword(password);
  try {
    return await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('deployx:register', 0))`);
      const { rows: admins } = await client.query(`SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1`);
      const role = admins.length === 0 ? 'ADMIN' : 'USER';
      const { rows } = await client.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
        [name, email, passwordHash, role],
      );
      return rows[0];
    });
  } catch (err) {
    if (err.code === '23505') throw ApiError.conflict('An account with this email already exists');
    throw err;
  }
}

// Creates the account, or sets the password, role and name of an existing
// one (command-line administration, scripts/createUser.js). Returns
// { user, created }.
export async function upsertUser({ name, email, password, role }) {
  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, name = EXCLUDED.name
     RETURNING ${USER_COLUMNS}, (xmax = 0) AS created`,
    [name, email, passwordHash, role],
  );
  const { created, ...user } = rows[0];
  return { user, created };
}

export async function updatePasswordHash(userId, passwordHash) {
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

export async function recordSignIn(userId) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}
