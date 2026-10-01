import { z } from 'zod';
import { stringField } from './common.js';

export const PASSWORD_MIN_LENGTH = 12;
// scrypt handles any length; the cap only bounds the work per request.
export const PASSWORD_MAX_LENGTH = 256;

const email = stringField('Email')
  .trim()
  .toLowerCase()
  .min(1, { error: 'Email is required' })
  .max(255, { error: 'Email must be at most 255 characters' })
  .pipe(z.email({ error: 'Email must be a valid email address' }));

const name = stringField('Name')
  .trim()
  .min(1, { error: 'Name is required' })
  .max(100, { error: 'Name must be at most 100 characters' });

const newPassword = stringField('Password')
  .min(PASSWORD_MIN_LENGTH, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(PASSWORD_MAX_LENGTH, { error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters` });

export const registerSchema = z.strictObject({ name, email, password: newPassword });

// Sign-in does not repeat the password rules: it only says whether the
// credentials are right.
export const loginSchema = z.strictObject({
  email,
  password: stringField('Password')
    .min(1, { error: 'Password is required' })
    .max(PASSWORD_MAX_LENGTH, { error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters` }),
});

export { email as emailField, name as nameField, newPassword as newPasswordField };
