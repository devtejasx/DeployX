# Operations

How to run DeployX for real and keep it observable: reliability and recovery, structured logs, Prometheus metrics, health probes, the monitoring panel, alerting, backups, production configuration and the production checklist. Security settings are in [Security](SECURITY.md); fixes for common problems are in [Troubleshooting](TROUBLESHOOTING.md).

## Queue reliability, timeouts and recovery

| Situation | What happens |
| --------- | ------------ |
| Worker crash / killed | its job's lock expires; BullMQ hands the job to the next worker, which sees the deployment in `BUILDING`/`DEPLOYING`/`HEALTH_CHECK`, logs *Previous attempt was interrupted…* and starts the attempt again; an interrupted rollback ends `ROLLBACK_FAILED` (Phase 6) |
| Redis restart | API and workers reconnect by themselves; with AOF the queue survives |
| Redis data lost | the **recovery check** (below) ends affected deployments as `FAILED` |
| PostgreSQL restart | the attempt fails and is retried with backoff; nothing is reported `SUCCESS` that was not recorded |
| Job retry | 3 attempts, exponential backoff; final `FAILED` with the reason |
| Duplicate job | job ID = deployment ID; a finished deployment is never processed again |
| Long-running / stuck job | **`DEPLOYMENT_TIMEOUT_MS`** (30 min) bounds a whole attempt: the running command is killed, the deployment ends `FAILED` without retry, cleanup and rollback still run; a pipeline that does not stop within 2 min more is abandoned |
| Job lost | **recovery check** every `RECOVERY_INTERVAL_MS` (60 s, one worker at a time via an advisory lock): unfinished deployments unchanged for `STUCK_DEPLOYMENT_AFTER_MS` (10 min) whose job is missing or already over are ended `FAILED` (`ROLLBACK_FAILED` if they were rolling back) with the reason logged. Deployments whose job is waiting or running are left alone |

Bounded timeouts for every long-running operation:

| Operation | Limit |
| --------- | ----- |
| Git clone / checkout | `GIT_TIMEOUT_MS` 2 min per command |
| Docker build, ECR push | `DOCKER_BUILD_TIMEOUT_MS` 10 min |
| Docker run, inspect, rm, tag, login | `DOCKER_COMMAND_TIMEOUT_MS` 60 s |
| Health check | `HEALTH_CHECK_TIMEOUT_MS` per request × at most `HEALTH_CHECK_RETRIES` (capped at 50) + intervals + grace |
| ECS rollout | `AWS_ECS_DEPLOY_TIMEOUT_MS` 10 min |
| Each AWS / GitHub API call | 30 s / 10 s |
| Rollback | the same per-step limits (restore + health check) |
| Whole attempt | `DEPLOYMENT_TIMEOUT_MS` 30 min |
| SQL statement | 15 s (API) / 30 s (worker) |

A timeout always ends in a final state (`FAILED`, or `ROLLBACK_FAILED`) with a log line saying which limit was hit.

## Observability: structured logs

API and worker write **one JSON object per line** to stdout/stderr ([`logger.js`](../server/src/lib/logger.js)): `timestamp`, `level`, `service` (`deployx-api` / `deployx-worker`), `event`, and the IDs that apply: `requestId`, `deploymentId`, `projectId`, `jobId`, `userId`, plus `status`, `durationMs`, `route`, `msg` and a serialized `err`. Examples:

```json
{"timestamp":"2026-10-01T10:06:23.512Z","level":"info","service":"deployx-worker","event":"deployment_completed","deploymentId":"ad07221f-…","projectId":"eb76f08a-…","status":"SUCCESS","target":"LOCAL","durationMs":14012}
{"timestamp":"2026-10-01T10:06:09.101Z","level":"info","service":"deployx-api","event":"http_request","requestId":"6c1e…","method":"POST","route":"/api/projects/:id/deployments","status":201,"durationMs":38,"userId":"…","ip":"127.0.0.1"}
```

`LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`) and `LOG_FORMAT=pretty` (one readable line, for development). Probes are logged at `debug`. Ship stdout to CloudWatch Logs (the `awslogs` driver on ECS), Loki or any collector. Deployment logs shown in the dashboard remain in PostgreSQL as before.

## Metrics

Prometheus text format ([prom-client](https://github.com/siimon/prom-client)). The API serves `GET /metrics`; every worker serves `GET /metrics` on `WORKER_METRICS_PORT` (9464). With `METRICS_TOKEN` set, scrapers must send `Authorization: Bearer <token>`; without one the endpoints are open in development and the API's is **disabled in production**.

| Metric | Source | Meaning |
| ------ | ------ | ------- |
| `deployx_deployments_total{trigger,target}` | API | deployments created |
| `deployx_deployments_success_total{target}` | worker | ended `SUCCESS` |
| `deployx_deployments_failed_total{status,target}` | worker | ended `FAILED` / `ROLLBACK_FAILED` |
| `deployx_deployments_rollback_total{outcome}` | worker | automatic rollbacks: `COMPLETED`, `FAILED`, `NOT_AVAILABLE` |
| `deployx_deployment_duration_seconds{status,target}` | worker | histogram, first start → final status |
| `deployx_health_check_failures_total` | worker | failed health-check attempts |
| `deployx_deployment_timeouts_total`, `deployx_stuck_deployments_recovered_total{status}` | worker | timeouts and recoveries |
| `deployx_worker_jobs_active`, `deployx_worker_jobs_completed_total`, `deployx_worker_jobs_failed_total{final}` | worker | job activity |
| `deployx_worker_last_heartbeat_timestamp_seconds` | worker | last heartbeat written |
| `deployx_queue_depth`, `deployx_queue_jobs{state}` | API (from Redis) | jobs waiting / per state |
| `deployx_workers{status}` | API (from heartbeats) | live workers: `running`, `stopping` |
| `deployx_deployments_in_progress{status}`, `deployx_deployments_stuck` | API (from PostgreSQL) | unfinished deployments; unchanged for 15 min |
| `deployx_dependency_up{dependency}` | API | PostgreSQL / Redis reachable |
| `deployx_http_request_duration_seconds{method,route,status_code}`, `deployx_http_request_errors_total` | API | latency per route pattern (never concrete IDs), 5xx count |
| `deployx_login_failures_total`, `deployx_rate_limited_total{limiter}`, `deployx_webhook_deliveries_total{outcome}` | API | security signals |
| `deployx_api_*`, `deployx_worker_*` process metrics | both | CPU, memory, event loop, GC |

Counters are counted where things happen, in the process that did them; system-wide gauges are read from Redis and PostgreSQL at scrape time, so every API instance reports the same real values. [`monitoring/prometheus.yml`](../monitoring/prometheus.yml) is a ready scrape configuration.

## Health endpoints

| Endpoint | Kind | Answers |
| -------- | ---- | ------- |
| `GET /health`, `GET /api/health` | API liveness | `200` while the process runs; never touches PostgreSQL or Redis, so an outage does not get the API restarted |
| `GET /ready`, `GET /api/ready` | API readiness | `200` when PostgreSQL and Redis answer and no shutdown is in progress, else `503` with `{ checks: { postgres, redis, shutdown } }` (which check failed, never why) |
| `GET /api/system/status` | dashboard | per-service status (error details for ADMIN only) |
| worker `GET /health` | liveness | `200` |
| worker `GET /ready` | readiness | `200` when Redis and PostgreSQL answer and the worker is consuming jobs; `503` while draining |

Use `/health` for container restarts (Compose healthchecks now do) and `/ready` for load-balancer target health.

## Worker health

Every worker writes a **heartbeat** to Redis every `HEARTBEAT_INTERVAL_MS` (10 s) and whenever a job starts or ends: `<QUEUE_PREFIX>:workers:<id>` = `{ id, hostname, pid, status, startedAt, lastHeartbeat, activeJobs, concurrency }`, with a TTL of three intervals. A worker that is killed, hangs or loses Redis disappears by itself; a graceful shutdown marks it `stopping` while it drains, then removes the key. The API reads these keys: nothing about workers is assumed or invented, and "Redis unavailable" is shown as unknown, not as zero workers.

## Deployment monitoring (dashboard)

`GET /api/monitoring/overview` and the dashboard's **Monitoring** panel (refreshed every 5 s) show, from real data only:

- active **alerts** (below), or "No active alerts"
- applications by state: **deploying, rolling back, rollback failed, failed, rolled back (previous version live), healthy**
- **workers** (running/stopping, busy job slots, last heartbeat), the **queue** (waiting, running, retry pending, failed), PostgreSQL/Redis state
- the last 24 hours: succeeded, failed, rollback failed, rollbacks
- deployments **in progress** and **recent failures**, linked to their details and live logs

Deployment data is scoped like the rest of the API (a USER sees its own projects).

## Alerting

The same conditions are evaluated in two places: by the API for the dashboard (thresholds `ALERT_*`), and as Prometheus rules for paging ([`monitoring/alert-rules.yml`](../monitoring/alert-rules.yml), validated with `promtool check rules`).

| Alert | Severity | Condition (defaults) |
| ----- | -------- | -------------------- |
| PostgreSQL unavailable | critical | the API cannot reach it |
| Redis unavailable | critical | the API cannot reach it |
| Worker unavailable | critical | no running worker heartbeat (Prometheus: for 2 min) |
| Rollback failed | critical | any `ROLLBACK_FAILED` (dashboard: last 24 h; Prometheus: last 15 min) |
| Queue backlog | warning | ≥ 10 jobs waiting (Prometheus: for 10 min) |
| High failure rate | warning | ≥ 50 % of ≥ 5 deployments in the last hour failed |
| Repeated rollback | warning | a project rolled back ≥ 3 times in 24 h |
| Health-check failures | warning | ≥ 3 deployments failed their health check in the last hour (Prometheus: ≥ 15 failed attempts) |
| AWS deployment failures | warning | ≥ 3 `AWS_ECS` deployments failed in the last hour |
| Stuck deployments | warning | unfinished deployments unchanged for 15 min |
| Prometheus only | warning | deployment timeouts, ≥ 50 failed sign-ins in 15 min, invalid webhook signatures, API 5xx rate, API not scrapable |

**Delivery.** [`monitoring/alertmanager.example.yml`](../monitoring/alertmanager.example.yml) routes `critical` to **PagerDuty** and **Slack**, `warning` to **Slack** and a daily **email** digest; receiver secrets are read from files. On AWS without Prometheus, the same conditions map onto **CloudWatch**: ship the JSON logs to CloudWatch Logs, create metric filters (e.g. `{ $.event = "deployment_failed" }`, `{ $.event = "stuck_deployment_recovered" }`), alarms on them and on the ECS service's running task count for the worker, and an SNS topic subscribed by email, Slack (AWS Chatbot) or PagerDuty. Amazon Managed Service for Prometheus can also scrape `/metrics` and use the rules file as-is.

## Graceful shutdown

- **API** (`SIGTERM`/`SIGINT`, [`lib/shutdown.js`](../server/src/lib/shutdown.js), tested on a real server in [`graceful-shutdown.test.js`](../server/test/graceful-shutdown.test.js)): readiness turns `503` → the server stops accepting connections and closes idle keep-alive ones → live log streams end (browsers reconnect elsewhere) → running requests finish → background timers stop → event subscriber, queue, Redis and PostgreSQL close → exit. Forced after `API_SHUTDOWN_TIMEOUT_MS` (10 s). The API holds no deployment state of its own.
- **Worker**: heartbeat `stopping` and readiness `503` → no new jobs → running jobs finish (up to `WORKER_SHUTDOWN_TIMEOUT_MS`) → recovery check, heartbeat, metrics server, Redis and PostgreSQL close → exit. A job still running when the timeout hits is resumed by the next worker (see the table above); nothing is left in a state that cannot be recovered.
- Both log `unhandledRejection`; an `uncaughtException` is logged and the process exits for the orchestrator to restart it.

## Backup and recovery

**PostgreSQL is the source of truth** for users, projects, deployments, logs, sessions and the audit log. Redis holds only a work queue and short-lived data: it is never the record of what was deployed.

- **Database backup:** on AWS use RDS/Aurora automated backups with point-in-time recovery (7–35 days) plus a daily snapshot copied to another region/account. Self-hosted: a nightly logical dump and WAL archiving for point-in-time recovery, encrypted and stored off-host; test a restore regularly.

  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > deployx-$(date +%F).dump
  ```

- **Database restore:** stop the API and workers, restore, run migrations, start again.

  ```bash
  pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" deployx-2026-10-01.dump
  npm run migrate
  ```

  Sessions in the backup are as old as the backup; users simply sign in again if theirs expired.
- **Migration recovery:** migrations run in a transaction each and take an advisory lock; a failed one leaves the schema unchanged. Fix it and run `npm run migrate` again, or revert the last one with `npm run migrate:down` (every migration has a tested down step). Take a backup before migrating production. A down step removes what its migration added: reverting the Phase 8 migration drops roles, password hashes, sessions and the audit log (deployment history is kept; verified in Phase 9). So in production, recover from a bad migration by **restoring the backup taken before it**, not with `migrate:down`. The whole procedure (dump, deleting all deployment history, restore, migrate) was run in Phase 9 and restored every row identically.
- **Redis recovery:** with AOF the queue survives restarts. If Redis data is lost, start Redis empty: the API and workers reconnect, and within `STUCK_DEPLOYMENT_AFTER_MS` the recovery check ends the deployments whose jobs vanished as `FAILED`, with the reason. Deploy them again. Rate-limit counters and heartbeats rebuild themselves.
- **Deployment recovery:** deployments always end in a final state (timeouts, recovery check). The last **stable** deployment of each project is derived from the history, so after any incident redeploy it, or push again. A `ROLLBACK_FAILED` deployment needs a person: check its logs, then redeploy a known-good commit.
- **AWS recovery:** images are in ECR by digest and every deployment records its task definition revision. To restore a version by hand, update the ECS service to the recorded `aws_task_definition_arn` (or redeploy it in DeployX). Keep ECR lifecycle rules from deleting images younger than your rollback window, and enable the ECS deployment circuit breaker.

## Production configuration

`NODE_ENV=production` changes the defaults that matter: Secure session cookies, registration off, HSTS on, `/metrics` closed without a token, and the startup configuration check. [`.env.production.example`](../.env.production.example) lists every production setting with placeholders (never real values); development starts from [`.env.example`](../.env.example). Development and test use their own databases and queue prefixes (the tests use `<db>_test` and `deployx-test`), so they cannot touch production data. Every variable is in [`.env.example`](../.env.example); the Phase 8 additions:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `ALLOW_REGISTRATION` | `true`, `false` in production | self-service sign-up |
| `SESSION_TTL_HOURS` / `SESSION_IDLE_TIMEOUT_MINUTES` | `12` / `60` | session lifetime / idle timeout |
| `SESSION_CLEANUP_INTERVAL_MS` | `3600000` | how often expired sessions are deleted |
| `SESSION_COOKIE_SECURE` | `true` in production | HTTPS-only cookie |
| `PASSWORD_HASH_COST` | `17` | log2 of scrypt's N |
| `CLIENT_URL` | `http://localhost:3000` | dashboard origin(s), comma-separated: CORS and cross-site checks |
| `TRUST_PROXY` | off | proxy hops in front of the API |
| `RATE_LIMIT_*` | see [Rate limiting](SECURITY.md#rate-limiting) | |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | |
| `METRICS_TOKEN` | *(empty)* | bearer token for `/metrics` (API and worker) |
| `API_SHUTDOWN_TIMEOUT_MS` | `10000` | |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` API, `30000` worker | |
| `DEPLOYMENT_TIMEOUT_MS` | `1800000` | one deployment attempt |
| `RECOVERY_INTERVAL_MS` / `STUCK_DEPLOYMENT_AFTER_MS` | `60000` / `600000` | recovery check |
| `HEARTBEAT_INTERVAL_MS` | `10000` | worker heartbeat |
| `WORKER_METRICS_PORT` / `WORKER_METRICS_HOST` | `9464` / `127.0.0.1` | worker `/health`, `/ready`, `/metrics` (`off` disables) |
| `AWS_CONNECTION_TIMEOUT_MS` / `AWS_REQUEST_TIMEOUT_MS` | `5000` / `30000` | every AWS call |
| `ALERT_*` | see [Alerting](#alerting) | dashboard alert thresholds |

**Production deployment.** Docker Compose in this repository is a development stack (Vite dev server, local PostgreSQL/Redis, the Docker socket). For production:

1. Managed PostgreSQL (RDS) and Redis (ElastiCache with auth + TLS) on private subnets.
2. The API as a container (`server/Dockerfile`, non-root) behind an HTTPS load balancer; health check `/health`, target readiness `/ready`; `TRUST_PROXY=1`.
3. The dashboard from `client/Dockerfile` target **`production`**: unprivileged nginx serving the built files with a strict CSP (`default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`, HSTS) and proxying `/api` (including SSE, unbuffered) to `API_UPSTREAM`:

   ```bash
   docker build --target production -t deployx-client ./client
   docker run -p 8080:8080 -e API_UPSTREAM=http://deployx-api:5000 deployx-client
   ```

4. Workers on a dedicated build host/VM (see [Docker security](SECURITY.md#docker-security)), with the IAM role and `METRICS_TOKEN`.
5. Migrations as a one-off task before each release: `node src/db/migrate.js up`.
6. The first administrator with `npm run user:create`, then `ALLOW_REGISTRATION=false`.
7. Prometheus + Alertmanager (or CloudWatch) from [`monitoring/`](../monitoring).

## Performance notes

Measured against the actual query patterns rather than tuned blindly: the only queries that run continually are the dashboard overview (every 5 s per open dashboard), the `/metrics` gauges (every scrape), the recovery check (every minute) and session lookups (every request, by unique hash). Session lookups use the unique token-hash index; the other three were measured with `EXPLAIN ANALYZE` on a seeded database (200 projects, 100,000 finished and 20 unfinished deployments; median of 7 runs):

| Query | Without the Phase 8 indexes | With them |
| ----- | --------------------------- | --------- |
| Recovery check (unfinished, unchanged for 10 min) | 11.9 ms, sequential scan | 0.04 ms, `deployments_unfinished_idx` |
| `deployx_deployments_in_progress` gauge | 10.9 ms, sequential scan | 0.04 ms, `deployments_unfinished_idx` |
| Overview: outcomes of the last 24 hours | 6.4 ms, sequential scan | 0.05 ms, `deployments_finished_at_idx` |

Without the indexes the cost grows with the whole deployment history; with them it depends only on the unfinished or recent deployments. No other index was added. Memory stays bounded: SSE streams read logs in batches of 500 and hold no backlog, log lines are capped at 10,000 characters, stored build output at 150 lines per attempt, one shared Redis subscriber serves all streams, BullMQ keeps completed jobs for 24 h / 1,000 and failed jobs for 7 days, metric labels use route patterns (never IDs), and the in-memory rate-limit fallback sweeps expired windows.

## Production checklist

- [ ] `NODE_ENV=production` on the API and the worker; the API starts (configuration check passes)
- [ ] Strong, unique `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `GITHUB_WEBHOOK_SECRET` (≥ 20 random characters), `METRICS_TOKEN`, all from a secret store
- [ ] PostgreSQL and Redis on private networks, TLS on, never published publicly
- [ ] API and dashboard only behind HTTPS; `CLIENT_URL` = the public HTTPS origin; `TRUST_PROXY` = the number of proxies in front of the API (check that the audit log shows real client addresses), and the API port reachable only through them
- [ ] GitHub webhook points at the production origin, push events only, content type JSON; a test push delivered (`202`) and a redelivery answered *Already deployed*
- [ ] `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_ECS_CLUSTER` and each project's ECS service and service URL checked against the AWS console; one real deployment and one rollback done on AWS
- [ ] Dashboard served from the `production` image (CSP, HSTS)
- [ ] First ADMIN created with `npm run user:create`; `ALLOW_REGISTRATION=false`
- [ ] Worker on a dedicated build host; AWS access through an IAM role with the least-privilege policy; no access keys
- [ ] GitHub App key only on the worker; App permissions: Contents read-only
- [ ] Migrations run before each release; database backups and point-in-time recovery enabled; a restore tested
- [ ] Redis with AOF and `noeviction`
- [ ] Prometheus scraping the API and every worker; alert rules loaded; Alertmanager (or CloudWatch alarms) delivering to a real channel; a test alert received
- [ ] Logs shipped and retained; nothing secret in them
- [ ] `npm audit` clean (see [Dependency security](SECURITY.md#dependency-security) for the current state); the full test suite, the frontend tests and the Docker tests pass

## Known limitations

- **Real AWS deployment is still not verified against an AWS account**: the AWS path is tested end to end against fakes of ECR and ECS (as in Phase 7), and the SDK clients and IAM policy are reviewed, but no real ECR/ECS run has been done.
- The worker's Docker socket access (see [Docker security](SECURITY.md#docker-security)) is unchanged; isolate the worker host.
- Rate limits fall back to per-instance memory while Redis is down (each API instance then allows the full limit).
- Sign-in is email and password only: no OAuth/SSO, MFA, password reset by email, or user management UI (use `user:create`). There is one ADMIN/USER role pair and no per-project sharing.
- The Docker Compose file is a development stack; see [Production configuration](#production-configuration).
- Deployed `LOCAL` apps do not come back after the Docker host restarts (found in the Phase 9 validation); redeploy each project's stable commit. See [Troubleshooting](TROUBLESHOOTING.md#known-issues-found-in-the-phase-9-validation).
