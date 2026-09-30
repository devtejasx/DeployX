import { useEffect, useState } from 'react';
import { getDeployment } from '../api/deploymentsApi.js';
import { apiUrl } from '../api/http.js';

const MAX_RECONNECT_DELAY_MS = 10000;

function compareLogIds(a, b) {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Live view of one deployment through GET /api/deployments/:id/logs/stream.
//
// Returns { deployment, logs, connection, ended, error }:
//   deployment  the deployment as last sent by the server (status events,
//               sent whenever the record changes: status, health check, ...)
//   logs        every log line, each once, in database order
//   connection  'connecting' | 'live' | 'reconnecting' | 'closed' | 'failed'
//   ended       true once the deployment reached a final status
//
// Reconnects: the browser's EventSource reconnects by itself and sends
// Last-Event-ID. If it gives up (e.g. the dev proxy answered 502 while the
// API restarted), a new stream is opened with ?lastEventId=, so only missing
// lines are sent; lines are also de-duplicated by id here.
export function useDeploymentStream(deploymentId) {
  const [state, setState] = useState({ deployment: null, logs: [], connection: 'connecting', ended: false, error: null });

  useEffect(() => {
    if (!deploymentId) return undefined;

    let source = null;
    let retryTimer = null;
    let attempts = 0;
    let stopped = false;
    const seen = new Set();
    let lastLogId = null;

    setState({ deployment: null, logs: [], connection: 'connecting', ended: false, error: null });

    function open() {
      const query = lastLogId ? `?lastEventId=${encodeURIComponent(lastLogId)}` : '';
      source = new EventSource(apiUrl(`/deployments/${deploymentId}/logs/stream${query}`));

      source.addEventListener('open', () => {
        attempts = 0;
        setState((current) => ({ ...current, connection: 'live', error: null }));
      });

      source.addEventListener('log', (event) => {
        const log = JSON.parse(event.data);
        if (seen.has(log.id)) return; // duplicate after a reconnect
        seen.add(log.id);
        lastLogId = log.id;
        setState((current) => {
          const logs = [...current.logs, log];
          // Lines arrive in order; sort only if one ever does not.
          if (logs.length > 1 && compareLogIds(logs.at(-2), log) > 0) logs.sort(compareLogIds);
          return { ...current, logs };
        });
      });

      source.addEventListener('status', (event) => {
        const deployment = JSON.parse(event.data);
        setState((current) => ({ ...current, deployment }));
      });

      source.addEventListener('end', () => {
        stopped = true;
        source.close();
        setState((current) => ({ ...current, ended: true, connection: 'closed' }));
      });

      source.addEventListener('error', () => {
        if (stopped) return;
        if (source.readyState === EventSource.CONNECTING) {
          // The browser is retrying on its own (Last-Event-ID included).
          setState((current) => ({ ...current, connection: 'reconnecting' }));
          return;
        }
        // The browser gave up: retry ourselves, unless the deployment is gone.
        source.close();
        setState((current) => ({ ...current, connection: 'reconnecting' }));
        const delay = Math.min(1000 * 2 ** attempts, MAX_RECONNECT_DELAY_MS);
        attempts += 1;
        retryTimer = setTimeout(async () => {
          try {
            await getDeployment(deploymentId);
          } catch (err) {
            if (err.status === 404) {
              stopped = true;
              setState((current) => ({ ...current, connection: 'failed', error: err.message }));
              return;
            }
            // API still unreachable: try again later.
          }
          if (!stopped) open();
        }, delay);
      });
    }

    open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [deploymentId]);

  return state;
}
