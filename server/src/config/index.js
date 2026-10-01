import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repository-root .env when running outside Docker. Docker Compose
// injects variables directly, so a missing file is expected there.
const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  process.loadEnvFile(rootEnvPath);
} catch {
  // No .env file - rely on the process environment.
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// "true"/"false"; anything else (including unset) means `fallback`.
function booleanSetting(value, fallback) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://deployx:deployx@localhost:5432/deployx',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // BullMQ deployment queue. The worker must use the same prefix.
  queue: {
    prefix: process.env.QUEUE_PREFIX || 'deployx',
    // Total tries per deployment job, including the first one.
    attempts: positiveInt(process.env.DEPLOYMENT_JOB_ATTEMPTS, 3),
    // Exponential backoff base: retries wait base, 2 x base, 4 x base, ...
    backoffMs: positiveInt(process.env.DEPLOYMENT_JOB_BACKOFF_MS, 2000),
  },
  // Live log streams (SSE): how often each stream re-checks the database in
  // case a Redis event was missed, and how often it sends a keep-alive.
  logStream: {
    pollMs: positiveInt(process.env.LOG_STREAM_POLL_MS, 2000),
    heartbeatMs: positiveInt(process.env.LOG_STREAM_HEARTBEAT_MS, 15000),
  },
  // GitHub push webhooks (POST /api/webhooks/github). Every delivery must be
  // signed with this secret (X-Hub-Signature-256); without it, webhooks are
  // refused. Only the API knows it; it is never logged or sent to clients.
  github: {
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  },
  // Sign-in (services/session.service.js, services/password.js).
  auth: {
    // Absolute lifetime of a session, and how long it survives without a request.
    sessionTtlHours: positiveInt(process.env.SESSION_TTL_HOURS, 12),
    idleTimeoutMinutes: positiveInt(process.env.SESSION_IDLE_TIMEOUT_MINUTES, 60),
    // Secure (HTTPS-only) session cookie; on by default in production.
    cookieSecure: booleanSetting(process.env.SESSION_COOKIE_SECURE, env === 'production'),
    // Self-service sign-up; off by default in production, where accounts are
    // created with `npm run user:create`.
    allowRegistration: booleanSetting(process.env.ALLOW_REGISTRATION, env !== 'production'),
    // log2 of scrypt's N (17 = 128 MiB per hash, the OWASP recommendation).
    passwordHashCost: Math.min(Math.max(positiveInt(process.env.PASSWORD_HASH_COST, 17), 10), 20),
  },
};

export default config;
