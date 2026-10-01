import { apiRequest } from './http.js';

// Sign-in endpoints. Each successful call sets or clears the HttpOnly
// session cookie; the responses contain the user, never a token.

export async function fetchCurrentUser(options) {
  return (await apiRequest('/auth/me', options)).user;
}

export async function signIn(email, password) {
  return (await apiRequest('/auth/login', { method: 'POST', body: { email, password } })).user;
}

export async function register(name, email, password) {
  return (await apiRequest('/auth/register', { method: 'POST', body: { name, email, password } })).user;
}

export function signOut() {
  return apiRequest('/auth/logout', { method: 'POST' });
}
