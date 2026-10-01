import { useCallback, useEffect, useState } from 'react';
import { fetchCurrentUser, signOut as apiSignOut } from '../api/authApi.js';
import { UNAUTHORIZED_EVENT } from '../api/http.js';

// Who is signed in, according to the API (GET /api/auth/me). The browser's
// session cookie is HttpOnly, so this is the only way the dashboard knows.
//
// Returns { status: 'loading' | 'signed-in' | 'signed-out' | 'error', user,
// error, setUser, signOut, retry }. Any 401 from the API (an expired
// session) signs the dashboard out. What a user may do is decided by the
// API on every request; the role here only labels the account.
export function useAuth() {
  const [state, setState] = useState({ status: 'loading', user: null, error: null });

  const load = useCallback(async () => {
    setState({ status: 'loading', user: null, error: null });
    try {
      const user = await fetchCurrentUser();
      setState({ status: 'signed-in', user, error: null });
    } catch (err) {
      if (err.status === 401) setState({ status: 'signed-out', user: null, error: null });
      else setState({ status: 'error', user: null, error: err.message });
    }
  }, []);

  useEffect(() => {
    load();
    const onUnauthorized = () => setState({ status: 'signed-out', user: null, error: null });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [load]);

  const setUser = useCallback((user) => setState({ status: 'signed-in', user, error: null }), []);

  const signOut = useCallback(async () => {
    try {
      await apiSignOut();
    } finally {
      setState({ status: 'signed-out', user: null, error: null });
    }
  }, []);

  return { ...state, setUser, signOut, retry: load };
}
