// Structured logging: one JSON object per line on stdout/stderr, ready for
// CloudWatch Logs, Loki or any log pipeline:
//
//   {"timestamp":"...","level":"info","service":"deployx-worker","event":"deployment_queued",
//    "deploymentId":"...","projectId":"...","msg":"..."}
//
// LOG_LEVEL: debug | info (default) | warn | error | silent
// LOG_FORMAT: json (default) | pretty (one readable line, for development)
//
// Secrets never reach the output: values under sensitive keys (password,
// token, secret, authorization, cookie, private key, credentials, ...) are
// replaced by "[REDACTED]", and every string is scrubbed of credentials in
// URLs, bearer tokens, GitHub tokens, AWS access keys and PEM private keys.
// The same file exists in the API (server/src/lib/logger.js).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authorization|cookie|private[-_]?key|access[-_]?key|credential|signature|session[-_]?id|api[-_]?key/i;
const MAX_STRING = 4000;
const MAX_DEPTH = 6;

const SCRUBBERS = [
  // https://user:password@host -> https://***@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, '$1***@'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(x-access-token|deployx_session|__Host-deployx_session)[:=][^\s;,"']+/gi, '$1=[REDACTED]'],
];

export function scrubString(value) {
  let text = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [truncated]` : value;
  for (const [pattern, replacement] of SCRUBBERS) text = text.replace(pattern, replacement);
  return text;
}

function serializeError(err, depth) {
  const out = { name: err.name, message: scrubString(String(err.message ?? '')) };
  if (err.code !== undefined) out.code = err.code;
  if (err.statusCode !== undefined) out.statusCode = err.statusCode;
  if (err.stack) out.stack = scrubString(err.stack);
  if (err.cause && depth < MAX_DEPTH) out.cause = redact(err.cause, depth + 1);
  return out;
}

// A copy of `value` that is safe to log.
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value, depth);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[Object]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) && item !== null && item !== undefined && item !== '' ? '[REDACTED]' : redact(item, depth + 1);
  }
  return out;
}

function prettyLine(entry) {
  const { timestamp, level, service, event, msg, err, ...fields } = entry;
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  const error = err ? ` ${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}` : '';
  return `${timestamp} ${level.toUpperCase().padEnd(5)} [${service}] ${event}${msg ? ` - ${msg}` : ''}${pairs.length ? ` ${pairs.join(' ')}` : ''}${error}`;
}

export function createLogger({
  service,
  level = process.env.LOG_LEVEL || 'info',
  format = process.env.LOG_FORMAT || 'json',
  base = {},
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, event, fields = {}) {
    if (LEVELS[levelName] < threshold) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: levelName,
      service,
      event,
      ...redact({ ...base, ...fields }),
    };
    const line = format === 'pretty' ? prettyLine(entry) : JSON.stringify(entry);
    // Through console, so tests (and anything else) can capture the output.
    if (levelName === 'error') console.error(line);
    else if (levelName === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger({ service, level, format, base: { ...base, ...fields } }),
  };
}

export const logger = createLogger({ service: 'deployx-worker' });
