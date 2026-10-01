import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import config from '../config/index.js';
import redisConnection from '../db/redis.js';
import { ApiError } from '../utils/ApiError.js';

// Rate limits (express-rate-limit), counted in Redis so every API instance
// shares them. Each limit is a fixed window per key (client IP, signed-in
// user or email):
//
//   api            RATE_LIMIT_API_PER_MINUTE         per IP, every /api request
//   login          RATE_LIMIT_LOGIN_PER_15_MINUTES   failed sign-ins per IP
//   login email    RATE_LIMIT_LOGIN_PER_EMAIL        failed sign-ins per account, any IP
//   register       RATE_LIMIT_REGISTER_PER_HOUR      per IP
//   webhooks       RATE_LIMIT_WEBHOOKS_PER_MINUTE    per IP
//   deployments    RATE_LIMIT_DEPLOYMENTS_PER_MINUTE new deployments per user
//   projects       RATE_LIMIT_PROJECTS_PER_HOUR      new projects per user
//
// Over the limit: 429 with Retry-After and the RateLimit headers.
//
// When Redis is unreachable the limits are counted in this process's memory
// instead (per instance, but never "no limit"): Redis being down must neither
// open the API to brute force nor take it down.

// INCR + PEXPIRE in one atomic step. Returns [hits, milliseconds to reset].
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }`;

const COMMAND_TIMEOUT_MS = 500;
let lastFallbackWarning = 0;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis rate limit command timed out')), COMMAND_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

// An express-rate-limit store: Redis while it is connected, memory otherwise.
export class RedisFallbackStore {
  constructor(name, { redis = redisConnection } = {}) {
    this.redis = redis;
    // Unique per limiter (express-rate-limit uses it to tell stores apart).
    this.prefix = `${config.queue.prefix}:ratelimit:${name}:`;
    this.memory = new Map();
  }

  init(options) {
    this.windowMs = options.windowMs;
    // Expired in-memory windows are dropped once per window.
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.memory) if (entry.resetTime <= now) this.memory.delete(key);
    }, this.windowMs);
    this.sweeper.unref();
  }

  usingRedis() {
    return this.redis.status === 'ready';
  }

  warnFallback(err) {
    if (Date.now() - lastFallbackWarning > 60000) {
      lastFallbackWarning = Date.now();
      console.warn('[ratelimit] Redis unavailable, counting rate limits in memory:', err?.message ?? 'not connected');
    }
  }

  memoryIncrement(key) {
    const now = Date.now();
    let entry = this.memory.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { totalHits: 0, resetTime: now + this.windowMs };
      this.memory.set(key, entry);
    }
    entry.totalHits += 1;
    return { totalHits: entry.totalHits, resetTime: new Date(entry.resetTime) };
  }

  async increment(key) {
    if (this.usingRedis()) {
      try {
        const [hits, ttl] = await withTimeout(this.redis.eval(INCREMENT_SCRIPT, 1, this.prefix + key, this.windowMs));
        return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
      } catch (err) {
        this.warnFallback(err);
      }
    } else {
      this.warnFallback();
    }
    return this.memoryIncrement(key);
  }

  async decrement(key) {
    const entry = this.memory.get(key);
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
    if (this.usingRedis()) await withTimeout(this.redis.decr(this.prefix + key)).catch(() => {});
  }

  async resetKey(key) {
    this.memory.delete(key);
    if (this.usingRedis()) await withTimeout(this.redis.del(this.prefix + key)).catch(() => {});
  }
}

function tooManyRequests(req, res, next, options) {
  const resetTime = req.rateLimit?.resetTime;
  const seconds = resetTime ? Math.max(Math.ceil((resetTime.getTime() - Date.now()) / 1000), 1) : Math.ceil(options.windowMs / 1000);
  next(new ApiError(429, `Too many requests; try again in ${seconds} seconds`));
}

const byIp = (req) => ipKeyGenerator(req.ip ?? '');
const byUser = (req) => (req.user ? `user:${req.user.id}` : `ip:${byIp(req)}`);

function limiter(name, { windowMs, limit, keyGenerator = byIp, ...options }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisFallbackStore(name),
    handler: tooManyRequests,
    ...options,
  });
}

const MINUTE = 60 * 1000;
const { rateLimit: limits } = config;

export const apiLimiter = limiter('api', { windowMs: MINUTE, limit: limits.apiPerMinute });

// Only failed sign-ins count: someone who signs in correctly is never locked out.
export const loginLimiter = limiter('login', {
  windowMs: 15 * MINUTE,
  limit: limits.loginPer15Minutes,
  skipSuccessfulRequests: true,
});

// Guessing one account's password from many addresses.
export const loginEmailLimiter = limiter('login-email', {
  windowMs: 15 * MINUTE,
  limit: limits.loginPerEmail,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `email:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 255) : ''}`,
});

export const registerLimiter = limiter('register', { windowMs: 60 * MINUTE, limit: limits.registerPerHour });

export const webhookLimiter = limiter('webhooks', { windowMs: MINUTE, limit: limits.webhooksPerMinute });

export const deploymentLimiter = limiter('deployments', {
  windowMs: MINUTE,
  limit: limits.deploymentsPerMinute,
  keyGenerator: byUser,
});

export const projectLimiter = limiter('projects', {
  windowMs: 60 * MINUTE,
  limit: limits.projectsPerHour,
  keyGenerator: byUser,
});
