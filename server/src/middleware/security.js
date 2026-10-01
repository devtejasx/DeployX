import cors from 'cors';
import helmet from 'helmet';
import config from '../config/index.js';
import { ApiError } from '../utils/ApiError.js';

// HTTP hardening of the API. The API only ever answers JSON (and SSE), so its
// Content-Security-Policy allows nothing at all; the dashboard is served
// separately with its own policy (client/nginx.conf, client/vite.config.js).
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  // HSTS only where the API is served over HTTPS (production).
  strictTransportSecurity: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
  xFrameOptions: { action: 'deny' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
});

// CORS for the configured dashboard origins only (CLIENT_URL), with
// credentials (the session cookie). Any other origin gets no CORS headers at
// all; the Origin header is compared with the list, never echoed blindly.
const allowedOrigins = new Set(config.clientOrigins);

export const corsPolicy = cors({
  origin: (origin, callback) => callback(null, Boolean(origin) && allowedOrigins.has(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Last-Event-ID', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 600,
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cross-site request forgery protection for cookie-authenticated requests.
// The session cookie is SameSite=Strict already; in addition, a browser
// request that changes something must come from the API's own origin or a
// configured dashboard origin. Requests without Origin / Sec-Fetch-Site
// (curl, scripts) are not browser-driven and are judged by their session
// like any other.
export function requireTrustedOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    const own = `${req.protocol}://${req.get('host')}`;
    if (origin !== own && !allowedOrigins.has(origin)) {
      throw new ApiError(403, 'Cross-origin request refused', undefined, undefined, 'CROSS_ORIGIN_REQUEST');
    }
  } else if (req.get('sec-fetch-site') === 'cross-site') {
    throw new ApiError(403, 'Cross-origin request refused', undefined, undefined, 'CROSS_ORIGIN_REQUEST');
  }
  next();
}

// Request bodies are JSON, and nothing else: a form post or text/plain body
// (what a cross-site form can send without a CORS preflight) is refused
// before it is read.
export function requireJsonBody(req, res, next) {
  const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (hasBody && !req.is('application/json')) {
    throw new ApiError(415, 'Request body must be JSON (Content-Type: application/json)');
  }
  next();
}

// API responses carry account data: never stored by browsers or proxies.
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// Request bodies the API accepts (projects, deployments, sign-in) are small.
export const JSON_BODY_LIMIT = '100kb';
