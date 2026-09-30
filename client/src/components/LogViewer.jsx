import { useEffect, useRef } from 'react';
import { formatTime } from '../utils/format.js';

const CONNECTION_LABELS = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Stream closed',
  failed: 'Stream unavailable',
};

// Closing line for a failed deployment, by its rollback outcome.
const FAILURE_NOTES = {
  COMPLETED: 'Deployment failed its health check. The previous stable version was restored.',
  FAILED: 'Deployment failed its health check, and the automatic rollback failed.',
  NOT_AVAILABLE: 'Deployment failed its health check. There was no stable version to roll back to.',
};

// Deployment log lines, following new lines while the reader is at the bottom
// (scrolling up to read earlier output pauses the auto-scroll).
export default function LogViewer({ logs, connection, status, rollbackStatus, ended }) {
  const listRef = useRef(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [logs.length]);

  function onScroll() {
    const list = listRef.current;
    stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  }

  return (
    <div className="logs">
      <div className="logs__header">
        <h3>Logs</h3>
        <span className={`connection connection--${connection}`} role="status">
          <span className="connection__dot" aria-hidden="true" />
          {CONNECTION_LABELS[connection]}
        </span>
      </div>

      <ol className="log-view" ref={listRef} onScroll={onScroll} aria-label="Deployment logs" aria-live="polite">
        {logs.map((line) => (
          <li key={line.id} className={`log-line log-line--${line.level.toLowerCase()}`}>
            <time className="log-line__time" dateTime={line.created_at}>
              {formatTime(line.created_at)}
            </time>
            <span className="log-line__message">{line.message}</span>
          </li>
        ))}
        {logs.length === 0 && <li className="muted">Waiting for log lines…</li>}
      </ol>

      {ended && status === 'SUCCESS' && <p className="notice notice--ok">Deployment completed successfully.</p>}
      {ended && status === 'FAILED' && (
        <p className="notice notice--error">{FAILURE_NOTES[rollbackStatus] ?? 'Deployment failed.'}</p>
      )}
    </div>
  );
}
