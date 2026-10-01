import { pingPostgres, query } from '../db/postgres.js';
import { pingRedis } from '../db/redis.js';
import { registerScrapeGauge } from '../lib/metrics.js';
import { getDeploymentQueue } from '../queues/deploymentQueue.js';

// Gauges read from PostgreSQL and Redis when Prometheus scrapes /metrics.

const UNFINISHED = ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK'];
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'prioritized', 'failed', 'completed', 'paused'];
const TIMEOUT_MS = 2000;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function up(ping) {
  try {
    await withTimeout(ping());
    return 1;
  } catch {
    return 0;
  }
}

registerScrapeGauge({
  name: 'deployx_dependency_up',
  help: '1 when the API reaches the dependency (postgres, redis), 0 otherwise',
  labelNames: ['dependency'],
  async collect(gauge) {
    const [postgres, redis] = await Promise.all([up(pingPostgres), up(pingRedis)]);
    gauge.set({ dependency: 'postgres' }, postgres);
    gauge.set({ dependency: 'redis' }, redis);
  },
});

registerScrapeGauge({
  name: 'deployx_queue_jobs',
  help: 'Deployment jobs in the BullMQ queue, by state',
  labelNames: ['state'],
  async collect(gauge) {
    const counts = await withTimeout(getDeploymentQueue().getJobCounts(...QUEUE_STATES));
    for (const state of QUEUE_STATES) gauge.set({ state }, counts[state] ?? 0);
  },
});

registerScrapeGauge({
  name: 'deployx_queue_depth',
  help: 'Deployment jobs waiting for a worker (waiting + delayed + prioritized)',
  async collect(gauge) {
    const counts = await withTimeout(getDeploymentQueue().getJobCounts('waiting', 'delayed', 'prioritized'));
    gauge.set((counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0));
  },
});

registerScrapeGauge({
  name: 'deployx_deployments_in_progress',
  help: 'Unfinished deployments, by status (from PostgreSQL)',
  labelNames: ['status'],
  async collect(gauge) {
    const { rows } = await withTimeout(
      query(
        `SELECT status, count(*)::int AS n FROM deployments WHERE status = ANY($1::varchar[]) GROUP BY status`,
        [UNFINISHED],
      ),
    );
    for (const status of UNFINISHED) gauge.set({ status }, rows.find((row) => row.status === status)?.n ?? 0);
  },
});
