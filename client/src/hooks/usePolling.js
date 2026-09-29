import { useCallback, useEffect, useRef, useState } from 'react';

// Loads `fetcher()` now and whenever `deps` change, and again every
// `intervalMs` while `shouldPoll(data)` is true. Returns { data, error,
// loading, reload }. Out-of-date responses are ignored.
export function usePolling(fetcher, deps, { intervalMs = 3000, shouldPoll = () => false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const requestId = useRef(0);
  const shouldPollRef = useRef(shouldPoll);
  shouldPollRef.current = shouldPoll;

  // `deps` decides when the fetcher is a different request (e.g. new project).
  const load = useCallback(fetcher, deps);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await load();
      if (id === requestId.current) setState({ data, error: null, loading: false });
    } catch (err) {
      if (id === requestId.current) setState((current) => ({ ...current, error: err.message, loading: false }));
    }
  }, [load]);

  useEffect(() => {
    setState({ data: null, error: null, loading: true });
    reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (shouldPollRef.current(state.data)) reload();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs, state.data]);

  return { ...state, reload };
}
