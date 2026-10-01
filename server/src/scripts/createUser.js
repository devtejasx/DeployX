// Creates an account, or sets the password and role of an existing one.
//
//   npm run user:create -- --email admin@example.com --name "Admin" --role ADMIN
//
// The password is read from the DEPLOYX_USER_PASSWORD environment variable,
// or else from the first line of standard input (so it never appears in the
// command line or the shell history):
//
//   printf '%s\n' "$PASSWORD" | npm run user:create -- --email ... --role ADMIN
//
// This is how production installations (ALLOW_REGISTRATION=false) get their
// first administrator, and how the Phase 2-7 development user
// (dev@deployx.local, which owns the projects created before Phase 8) gets a
// password and can sign in.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { closePostgres } from '../db/postgres.js';
import { upsertUser } from '../services/user.service.js';
import { emailField, nameField, newPasswordField } from '../validators/auth.validators.js';

function fail(message) {
  console.error(`[user:create] ${message}`);
  process.exitCode = 1;
}

async function readPassword() {
  if (process.env.DEPLOYX_USER_PASSWORD) return process.env.DEPLOYX_USER_PASSWORD;
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) process.stderr.write('Password: ');
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return '';
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'USER' },
    },
  });

  const email = emailField.safeParse(values.email);
  if (!email.success) return fail(email.error.issues[0].message);
  const name = nameField.safeParse(values.name ?? email.data.split('@')[0]);
  if (!name.success) return fail(name.error.issues[0].message);
  const role = String(values.role).toUpperCase();
  if (!['ADMIN', 'USER'].includes(role)) return fail('--role must be ADMIN or USER');
  const password = newPasswordField.safeParse(await readPassword());
  if (!password.success) return fail(password.error.issues[0].message);

  const { user, created } = await upsertUser({ name: name.data, email: email.data, password: password.data, role });
  console.log(`[user:create] ${created ? 'Created' : 'Updated'} ${user.email} (${user.role}, id ${user.id})`);
}

try {
  await main();
} catch (err) {
  fail(`failed: ${err.message || err.code || err}`);
} finally {
  await closePostgres();
}
