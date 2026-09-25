import { query } from '../db/postgres.js';

// Returns the user with this email, creating it first if it does not exist.
// Done in one statement so concurrent first requests cannot create duplicates.
export async function findOrCreateUserByEmail({ email, name }) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO users (email, name)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email, created_at, updated_at
     )
     SELECT id, name, email, created_at, updated_at FROM inserted
     UNION ALL
     SELECT id, name, email, created_at, updated_at FROM users WHERE email = $1
     LIMIT 1`,
    [email, name],
  );
  return rows[0];
}
