import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSystemStatus } from '../api/systemApi.js';

const REFRESH_INTERVAL_MS = 15000;

export function useSystemStatus() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef(null);

  const refresh = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    try {
      const data = await fetchSystemStatus({ signal: controller.signal });
      setStatus(data);
      setError(null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatus(null);
      setError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [refresh]);

  return { status, error, loading, refresh };
}
