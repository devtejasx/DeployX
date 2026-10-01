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

// CLIENT_URL: the dashboard's origin, or several separated by commas. Only
// these origins get CORS headers and may send state-changing requests from a
// browser; "*" is never accepted.
function parseOrigins(value) {
  const origins = new Set();
  for (const entry of (value || 'http://localhost:3000').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === '*') continue;
    try {
      const url = new URL(trimmed);
      if (['http:', 'https:'].includes(url.protocol)) origins.add(url.origin);
    } catch {
      // Not a URL: ignored (and reported by productionConfigProblems).
    }
  }
  return [...origins];
}

// TRUST_PROXY: unset/false when clients connect directly; the number of proxy
// hops (e.g. 1 behind one load balancer) or Express's names ("loopback") so
// req.ip is the real client address - rate limits and audit entries use it.
function trustProxySetting(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

const config = {
  env,
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  clientOrigins: parseOrigins(process.env.CLIENT_URL),
  trustProxy: trustProxySetting(process.env.TRUST_PROXY),
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
  // Requests allowed per window (middleware/rateLimit.js).
  rateLimit: {
    apiPerMinute: positiveInt(process.env.RATE_LIMIT_API_PER_MINUTE, 300),
    loginPer15Minutes: positiveInt(process.env.RATE_LIMIT_LOGIN_PER_15_MINUTES, 10),
    loginPerEmail: positiveInt(process.env.RATE_LIMIT_LOGIN_PER_EMAIL, 5),
    registerPerHour: positiveInt(process.env.RATE_LIMIT_REGISTER_PER_HOUR, 5),
    webhooksPerMinute: positiveInt(process.env.RATE_LIMIT_WEBHOOKS_PER_MINUTE, 120),
    deploymentsPerMinute: positiveInt(process.env.RATE_LIMIT_DEPLOYMENTS_PER_MINUTE, 20),
    projectsPerHour: positiveInt(process.env.RATE_LIMIT_PROJECTS_PER_HOUR, 30),
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

// Settings that must never reach production. Returns a list of problems
// (empty when the configuration is safe); server.js refuses to start in
// production while there are any.
export function productionConfigProblems(settings = config, rawClientUrl = process.env.CLIENT_URL) {
  const problems = [];
  const credentials = (url) => {
    try {
      const parsed = new URL(url);
      return { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
    } catch {
      return { user: '', password: '' };
    }
  };
  const db = credentials(settings.databaseUrl);
  if (!db.password || ['deployx', 'postgres', 'password'].includes(db.password)) {
    problems.push('DATABASE_URL uses a missing or development password');
  }
  const redis = credentials(settings.redisUrl);
  if (!redis.password || redis.password === 'deployx-dev-redis') {
    problems.push('REDIS_URL has no password or the development one');
  }
  if (!rawClientUrl) problems.push('CLIENT_URL is not set');
  if (rawClientUrl && rawClientUrl.split(',').some((entry) => entry.trim() === '*')) {
    problems.push('CLIENT_URL must list origins, not "*"');
  }
  for (const origin of settings.clientOrigins) {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(hostname)) {
      problems.push(`CLIENT_URL origin ${origin} is not HTTPS`);
    }
  }
  if (!settings.auth.cookieSecure) problems.push('SESSION_COOKIE_SECURE must not be false');
  if (settings.auth.passwordHashCost < 15) problems.push('PASSWORD_HASH_COST must be at least 15');
  if (settings.github.webhookSecret && settings.github.webhookSecret.length < 20) {
    problems.push('GITHUB_WEBHOOK_SECRET is too short (use at least 20 random characters)');
  }
  return problems;
}

export default config;
