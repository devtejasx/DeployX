import express from 'express';
import config from './config/index.js';
import apiRoutes from './routes/index.js';
import webhookRoutes from './routes/webhook.routes.js';
import { getHealth, getMetrics, getReadiness } from './controllers/health.controller.js';
import { notFound } from './middleware/notFound.js';
import { requestContext } from './middleware/requestContext.js';
import './services/metricsCollectors.js';
import { webhookLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';
import {
  JSON_BODY_LIMIT,
  corsPolicy,
  noStore,
  requireJsonBody,
  requireTrustedOrigin,
  securityHeaders,
} from './middleware/security.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(requestContext);
app.use(securityHeaders);
app.use(corsPolicy);
app.use(noStore);

// Probes for load balancers and orchestrators (also under /api), and
// Prometheus metrics. Not rate-limited, no session needed.
app.get('/health', getHealth);
app.get('/ready', getReadiness);
app.get('/metrics', getMetrics);

// Webhooks read their raw body (signature verification), so they come before
// the JSON parser. They carry no cookies and are authenticated by signature.
app.use('/api/webhooks', webhookLimiter, webhookRoutes);

app.use('/api', requireTrustedOrigin, requireJsonBody, express.json({ limit: JSON_BODY_LIMIT, strict: true }));
app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
