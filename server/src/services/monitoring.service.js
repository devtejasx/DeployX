import config from '../config/index.js';
import { pingPostgres, query } from '../db/postgres.js';
import redisConnection, { pingRedis } from '../db/redis.js';
import { registerScrapeGauge } from '../lib/metrics.js';
import { getDeploymentQueue } from '../queues/deploymentQueue.js';
import { isAdmin } from './access.js';

// What the dashboard's monitoring panel and its alerts are made of. Every
// number comes from the real system: worker heartbeats and queue counts from
// Redis, deployments from PostgreSQL. Nothing is estimated or invented; a
// source that cannot be read is reported as unavailable, not as zero.
//
// Deployment data is scoped like everything else: a USER sees its own
// projects, an ADMIN all of them. Infrastructure (workers, queue,
// dependencies) is the same for everyone; worker host names only for ADMIN.

const UNFINISHED = ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'ROLLING_BACK'];
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

async function reachable(ping) {
  try {
    await withTimeout(ping());
    return true;
  } catch {
    return false;
  }
}

// Heartbeats the workers wrote (worker/src/services/heartbeat.js). A key
// exists only while its worker keeps beating (it expires otherwise).
export async function listWorkers() {
  const prefix = `${config.queue.prefix}:workers:`;
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await withTimeout(redisConnection.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100));
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < 1000);
  if (keys.length === 0) return [];

  const values = await withTimeout(redisConnection.mget(keys));
  const now = Date.now();
  return values
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter((worker) => worker && typeof worker.id === 'string')
    .map((worker) => ({
      id: worker.id,
      hostname: worker.hostname,
      status: worker.status === 'stopping' ? 'stopping' : 'running',
      activeJobs: Number(worker.activeJobs) || 0,
      concurrency: Number(worker.concurrency) || 0,
      startedAt: worker.startedAt,
      lastHeartbeat: worker.lastHeartbeat,
      heartbeatAgeSeconds: Math.max(0, Math.round((now - Date.parse(worker.lastHeartbeat)) / 1000)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function queueCounts() {
  const counts = await withTimeout(getDeploymentQueue().getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'failed'));
  return {
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    depth: (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0),
  };
}

// Deployment facts for the projects `user` may see.
async function deploymentFacts(user) {
  const all = isAdmin(user);
  const scope = 'AND ($1::boolean OR p.user_id = $2)';
  const params = [all, user.id];

  const [active, finished, rollbacks, failures, projects, stuck] = await Promise.all([
    query(
      `SELECT d.id, d.project_id, p.name AS project_name, d.status, d.trigger, d.deployment_target,
              d.started_at, d.updated_at, d.created_at
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.status = ANY($3::varchar[]) ${scope}
       ORDER BY d.created_at
       LIMIT 50`,
      [...params, UNFINISHED],
    ),
    // Outcomes over the last 24 hours and the last hour.
    query(
      `SELECT d.status, d.deployment_target,
              count(*)::int AS day,
              count(*) FILTER (WHERE d.finished_at > now() - interval '1 hour')::int AS hour,
              count(*) FILTER (WHERE d.finished_at > now() - interval '1 hour'
                               AND d.error_message LIKE 'Health check failed%')::int AS health_hour
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.finished_at > now() - interval '24 hours' ${scope}
       GROUP BY d.status, d.deployment_target`,
      params,
    ),
    query(
      `SELECT d.project_id, p.name AS project_name, count(*)::int AS rollbacks
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.finished_at > now() - interval '24 hours'
         AND d.rollback_status IN ('COMPLETED', 'FAILED') ${scope}
       GROUP BY d.project_id, p.name`,
      params,
    ),
    query(
      `SELECT d.id, d.project_id, p.name AS project_name, d.status, d.deployment_target, d.rollback_status,
              left(d.error_message, 300) AS error_message, d.finished_at
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.status IN ('FAILED', 'ROLLBACK_FAILED') ${scope}
       ORDER BY d.finished_at DESC NULLS LAST
       LIMIT 10`,
      params,
    ),
    // Each project's state: its latest deployment, and whether one is running.
    query(
      `SELECT p.id, p.name, p.status AS project_status,
              latest.status AS latest_status, latest.rollback_status AS latest_rollback_status,
              EXISTS (SELECT 1 FROM deployments u WHERE u.project_id = p.id AND u.status = ANY($3::varchar[])) AS deploying,
              EXISTS (SELECT 1 FROM deployments r WHERE r.project_id = p.id AND r.status = 'ROLLING_BACK') AS rolling_back
       FROM projects p
       LEFT JOIN LATERAL (
         SELECT status, rollback_status FROM deployments f
         WHERE f.project_id = p.id AND f.finished_at IS NOT NULL
         ORDER BY f.finished_at DESC LIMIT 1
       ) latest ON true
       WHERE true ${scope}`,
      [...params, UNFINISHED],
    ),
    query(
      `SELECT count(*)::int AS n FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE d.status = ANY($3::varchar[]) AND d.updated_at < now() - make_interval(secs => $4) ${scope}`,
      [...params, UNFINISHED, config.alerts.stuckAfterMinutes * 60],
    ),
  ]);

  const outcomes = { day: {}, hour: {}, healthCheckFailuresHour: 0, awsFailuresHour: 0 };
  for (const row of finished.rows) {
    outcomes.day[row.status] = (outcomes.day[row.status] ?? 0) + row.day;
    outcomes.hour[row.status] = (outcomes.hour[row.status] ?? 0) + row.hour;
    outcomes.healthCheckFailuresHour += row.health_hour;
    if (row.deployment_target === 'AWS_ECS' && row.status !== 'SUCCESS') outcomes.awsFailuresHour += row.hour;
  }

  const projectStates = projects.rows.map((project) => {
    let state = 'never_deployed';
    if (project.rolling_back) state = 'rolling_back';
    else if (project.deploying) state = 'deploying';
    else if (project.latest_status === 'SUCCESS') state = 'healthy';
    else if (project.latest_status === 'ROLLBACK_FAILED') state = 'rollback_failed';
    // FAILED with a completed rollback: the previous version serves again.
    else if (project.latest_status === 'FAILED') state = project.latest_rollback_status === 'COMPLETED' ? 'rolled_back' : 'failed';
    return { id: project.id, name: project.name, state };
  });

  return {
    active: active.rows,
    outcomes,
    rollbacksByProject: rollbacks.rows,
    recentFailures: failures.rows,
    projects: projectStates,
    stuck: stuck.rows[0].n,
  };
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return counts;
}

// The alert conditions of README "Phase 8 - Alerting", evaluated on the data
// above. The same conditions exist as Prometheus rules
// (monitoring/alert-rules.yml) for paging; these are for the dashboard.
export function evaluateAlerts({ dependencies, workers, queue, facts }) {
  const { alerts: limits } = config;
  const alerts = [];
  const add = (id, severity, message) => alerts.push({ id, severity, message });

  if (!dependencies.postgres) add('POSTGRES_UNAVAILABLE', 'critical', 'PostgreSQL is unreachable: deployments cannot be recorded');
  if (!dependencies.redis) add('REDIS_UNAVAILABLE', 'critical', 'Redis is unreachable: no deployment can be queued or run');
  if (workers && !workers.some((worker) => worker.status === 'running')) {
    add('WORKER_UNAVAILABLE', 'critical', 'No worker is running: queued deployments will not start');
  }
  if (queue && queue.depth >= limits.queueBacklog) {
    add('QUEUE_BACKLOG', 'warning', `${queue.depth} deployments are waiting for a worker`);
  }
  if (facts) {
    const { hour } = facts.outcomes;
    const finished = Object.values(hour).reduce((sum, n) => sum + n, 0);
    const failed = (hour.FAILED ?? 0) + (hour.ROLLBACK_FAILED ?? 0);
    if (finished >= limits.failureRateMinDeployments && failed / finished >= limits.failureRate) {
      add('HIGH_FAILURE_RATE', 'warning', `${failed} of ${finished} deployments in the last hour failed`);
    }
    if ((facts.outcomes.day.ROLLBACK_FAILED ?? 0) > 0) {
      add('ROLLBACK_FAILED', 'critical', `${facts.outcomes.day.ROLLBACK_FAILED} deployment(s) could not be rolled back in the last 24 hours`);
    }
    for (const project of facts.rollbacksByProject) {
      if (project.rollbacks >= limits.repeatedRollbacks) {
        add('REPEATED_ROLLBACK', 'warning', `${project.project_name} was rolled back ${project.rollbacks} times in the last 24 hours`);
      }
    }
    if (facts.outcomes.healthCheckFailuresHour >= limits.healthCheckFailures) {
      add('HEALTH_CHECK_FAILURES', 'warning', `${facts.outcomes.healthCheckFailuresHour} deployments failed their health check in the last hour`);
    }
    if (facts.outcomes.awsFailuresHour >= limits.awsFailures) {
      add('AWS_DEPLOYMENT_FAILURES', 'warning', `${facts.outcomes.awsFailuresHour} AWS deployments failed in the last hour`);
    }
    if (facts.stuck > 0) {
      add('STUCK_DEPLOYMENTS', 'warning', `${facts.stuck} deployment(s) have not progressed for over ${limits.stuckAfterMinutes} minutes`);
    }
  }
  return alerts;
}

export async function getOverview(user) {
  const [postgres, redis] = await Promise.all([reachable(pingPostgres), reachable(pingRedis)]);
  const [workers, queue, facts] = await Promise.all([
    redis ? listWorkers().catch(() => null) : null,
    redis ? queueCounts().catch(() => null) : null,
    postgres ? deploymentFacts(user) : null,
  ]);
  const dependencies = { postgres, redis };

  return {
    generatedAt: new Date().toISOString(),
    dependencies: { postgres: postgres ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    workers: workers && {
      running: workers.filter((worker) => worker.status === 'running').length,
      stopping: workers.filter((worker) => worker.status === 'stopping').length,
      activeJobs: workers.reduce((sum, worker) => sum + worker.activeJobs, 0),
      capacity: workers.reduce((sum, worker) => sum + worker.concurrency, 0),
      list: workers.map(({ hostname, ...worker }) => (isAdmin(user) ? { ...worker, hostname } : worker)),
    },
    queue,
    deployments: facts && {
      inProgress: countBy(facts.active, 'status'),
      active: facts.active,
      last24Hours: facts.outcomes.day,
      lastHour: facts.outcomes.hour,
      rollbacksLast24Hours: facts.rollbacksByProject.reduce((sum, project) => sum + project.rollbacks, 0),
      recentFailures: facts.recentFailures,
      stuck: facts.stuck,
    },
    projects: facts && { counts: countBy(facts.projects, 'state'), list: facts.projects },
    alerts: evaluateAlerts({ dependencies, workers, queue, facts }),
  };
}

// For Prometheus (GET /metrics): live workers and stuck deployments.
registerScrapeGauge({
  name: 'deployx_workers',
  help: 'Workers with a live heartbeat, by status (running, stopping)',
  labelNames: ['status'],
  async collect(gauge) {
    const workers = await listWorkers();
    gauge.set({ status: 'running' }, workers.filter((worker) => worker.status === 'running').length);
    gauge.set({ status: 'stopping' }, workers.filter((worker) => worker.status === 'stopping').length);
  },
});

registerScrapeGauge({
  name: 'deployx_deployments_stuck',
  help: `Unfinished deployments not updated for ALERT_STUCK_AFTER_MINUTES`,
  async collect(gauge) {
    const { rows } = await withTimeout(
      query(
        `SELECT count(*)::int AS n FROM deployments
         WHERE status = ANY($1::varchar[]) AND updated_at < now() - make_interval(secs => $2)`,
        [UNFINISHED, config.alerts.stuckAfterMinutes * 60],
      ),
    );
    gauge.set(rows[0].n);
  },
});
