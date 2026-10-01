import { useState } from 'react';
import { register, signIn } from '../api/authApi.js';

// Sign-in and (where the server allows it) registration. The password only
// travels in the request body over the same origin; the session that comes
// back is an HttpOnly cookie the page never touches.
export default function SignIn({ onSignedIn }) {
  const [mode, setMode] = useState('sign-in');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState(null);

  const registering = mode === 'register';

  function change(field) {
    return (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  function switchMode() {
    setMode(registering ? 'sign-in' : 'register');
    setErrors(null);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setErrors(null);
    try {
      const user = registering
        ? await register(form.name, form.email, form.password)
        : await signIn(form.email, form.password);
      setForm({ name: '', email: '', password: '' });
      onSignedIn(user);
    } catch (err) {
      setErrors(err.body?.error?.details ?? [err.message]);
      setForm((current) => ({ ...current, password: '' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card auth" aria-labelledby="auth-heading">
      <h2 id="auth-heading">{registering ? 'Create an account' : 'Sign in'}</h2>
      <form className="settings__form auth__form" onSubmit={submit}>
        {registering && (
          <label>
            Name
            <input value={form.name} onChange={change('name')} autoComplete="name" required maxLength={100} />
          </label>
        )}
        <label>
          Email
          <input type="email" value={form.email} onChange={change('email')} autoComplete="email" required maxLength={255} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={change('password')}
            autoComplete={registering ? 'new-password' : 'current-password'}
            required
            minLength={registering ? 12 : 1}
            maxLength={256}
          />
        </label>
        {registering && <p className="settings__hint muted">At least 12 characters.</p>}

        {errors && (
          <div className="notice notice--error" role="alert">
            <ul className="settings__errors">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="auth__actions">
          <button type="button" className="link-button" onClick={switchMode}>
            {registering ? 'I already have an account' : 'Create an account'}
          </button>
          <button type="submit" className="button--primary" disabled={busy}>
            {busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}
          </button>
        </div>
      </form>
    </section>
  );
}
