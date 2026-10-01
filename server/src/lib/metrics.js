import client from 'prom-client';

// Prometheus metrics of the API (GET /metrics). The worker exposes its own
// (deployment outcomes, durations, health-check failures, active jobs) on its
// metrics port; see worker/src/lib/metrics.js.
//
// Gauges that describe the whole system (queue depth, unfinished
// deployments, live workers) are read from Redis and PostgreSQL when
// Prometheus scrapes, so every API instance reports the same, real values.

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'deployx-api' });
client.collectDefaultMetrics({ register: registry, prefix: 'deployx_api_' });

export const httpRequestDuration = new client.Histogram({
  name: 'deployx_http_request_duration_seconds',
  help: 'API request duration, by route pattern and status code',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestErrors = new client.Counter({
  name: 'deployx_http_request_errors_total',
  help: 'API requests answered with a 5xx status',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const deploymentsCreated = new client.Counter({
  name: 'deployx_deployments_total',
  help: 'Deployments created, by trigger (MANUAL, GITHUB_PUSH) and target (LOCAL, AWS_ECS)',
  labelNames: ['trigger', 'target'],
  registers: [registry],
});

export const loginFailures = new client.Counter({
  name: 'deployx_login_failures_total',
  help: 'Failed sign-in attempts',
  registers: [registry],
});

export const rateLimited = new client.Counter({
  name: 'deployx_rate_limited_total',
  help: 'Requests refused by a rate limit',
  labelNames: ['limiter'],
  registers: [registry],
});

export const webhookDeliveries = new client.Counter({
  name: 'deployx_webhook_deliveries_total',
  help: 'GitHub webhook deliveries, by outcome (accepted, rejected_signature, invalid)',
  labelNames: ['outcome'],
  registers: [registry],
});

// Gauges computed at scrape time. `collectors` are registered by the modules
// that own the data (queue, deployments, workers) to avoid import cycles.
export function registerScrapeGauge({ name, help, labelNames = [], collect }) {
  return new client.Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      this.reset();
      try {
        await collect(this);
      } catch {
        // A dependency is down: the gauge is left empty for this scrape
        // (deployx_dependency_up says which one).
      }
    },
  });
}
