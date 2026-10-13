# Local setup

Everything needed to run DeployX on one machine, configure it, and run its test suites. For a guided walkthrough of a deployment and a rollback, see the [demo guide](DEMO_GUIDE.md).

## Prerequisites

- **Node.js 20.12 or newer** (22 LTS recommended) and npm
- **Docker** with the Compose plugin (Docker Desktop on Windows/macOS)
- **Git**

## Quick start (Docker Compose)

The whole stack (PostgreSQL, Redis, migrations, API, dashboard, worker) runs with one command. Docker Desktop (or Docker Engine with the Compose plugin) must be running.

```bash
git clone https://github.com/devtejasx/DeployX.git
cd DeployX
cp .env.example .env            # optional: Compose falls back to the same development defaults
docker compose up -d --build    # first build takes a few minutes
docker compose ps               # postgres, redis, server, worker healthy; client up; migrate exited 0
```

Then create the first administrator, in either of two ways:

- **In the dashboard:** open http://localhost:3000, choose **Create an account**. The first account created while no ADMIN exists becomes ADMIN; later ones are USERs. (Registration is on in development and off with `NODE_ENV=production`.)
- **On the command line**, which is also how production gets its first ADMIN. The password is read from `DEPLOYX_USER_PASSWORD` or from standard input, never from an argument:

  ```bash
  read -rs DEPLOYX_USER_PASSWORD && export DEPLOYX_USER_PASSWORD   # type it (12+ characters); it is not echoed
  docker compose exec -e DEPLOYX_USER_PASSWORD server npm run user:create -- --email admin@example.com --name "Admin" --role ADMIN
  ```

  In PowerShell: `$env:DEPLOYX_USER_PASSWORD = Read-Host -MaskInput`, then the same `docker compose exec` line. It prints `[user:create] Created admin@example.com (ADMIN, id …)`.

  Running on the host instead (`npm run install:all` done), `npm run user:create -- --email … --role ADMIN` does the same from the repository root.

Sign in at http://localhost:3000, click **New** under Applications and create an application from this repository (`https://github.com/devtejasx/DeployX`, Dockerfile path `examples/hello-app/Dockerfile`, port `3000`), then **Deploy**. For the full walkthrough, including an automatic rollback, follow the [demo guide](DEMO_GUIDE.md) or run `npm run demo`.

On Windows, if PostgreSQL's port is reserved by the system, set `POSTGRES_PORT` and the port in `DATABASE_URL` to a free one such as `15432` (see [Troubleshooting](TROUBLESHOOTING.md#setup-and-local-development)).

## Running with Docker Compose

The services and what each one may access:

```bash
cp .env.example .env      # optional - Compose falls back to the same defaults
docker compose up --build
```

| Service    | Image / build        | Host port | Notes                                              |
| ---------- | -------------------- | --------- | -------------------------------------------------- |
| `postgres` | `postgres:17-alpine` | 127.0.0.1:5432 | `postgres-data` volume, healthcheck |
| `redis`    | `redis:7-alpine`     | 127.0.0.1:6379 | `redis-data` volume, healthcheck, **password required** |
| `migrate`  | `./server`           | -              | applies migrations, then exits with code 0 |
| `server`   | `./server`           | 127.0.0.1:5000 | starts after `migrate` succeeds and the DBs are healthy; the only service with `GITHUB_WEBHOOK_SECRET` |
| `client`   | `./client` (target `development`) | 127.0.0.1:3000 | Vite dev server, proxies `/api` to `server`; production image: target `production` |
| `worker`   | `./worker`           | -              | runs deployments; **the only service with the Docker socket**, the GitHub App key and AWS credentials (passed through from your environment, empty by default); health-checks apps through `host.docker.internal`; 30 s stop grace period |

Deployed apps are **not** Compose services. The worker starts them on the `deployx-apps` network, so `docker compose down` leaves them running. Remove them with `docker rm -f $(docker ps -aq --filter label=deployx.managed=true)`.

```bash
docker compose ps -a              # service status (including the finished migrate job)
docker compose logs -f server     # follow API logs
docker compose logs -f worker     # follow job processing
docker compose down               # stop everything (keeps data volumes)
docker compose down -v            # stop and delete the database/redis volumes
```

Images aren't rebuilt when you edit code. Run `docker compose up --build` again after a change.

## Running on the host

```bash
cp .env.example .env
npm run install:all       # client, server and worker dependencies
npm run infra:up          # docker compose up -d postgres redis
npm run migrate           # apply database migrations

# in separate terminals
npm run dev:server        # API on http://localhost:5000 (node --watch)
npm run dev:client        # dashboard on http://localhost:3000
npm run dev:worker        # processes deployment jobs
```

Then open http://localhost:3000 and create an account (the first account while no ADMIN exists becomes ADMIN).

## Environment variables

```bash
cp .env.example .env
```

`.env` is git-ignored. Only `.env.example` is committed, and it contains only local development defaults.

| Variable            | Default                                                | Used by                    |
| ------------------- | ------------------------------------------------------ | -------------------------- |
| `NODE_ENV`          | `development`                                          | server, worker             |
| `PORT`              | `5000`                                                 | server (also host port)    |
| `CLIENT_URL`        | `http://localhost:3000`                                | server: dashboard origin(s), comma-separated (CORS, cross-site checks) |
| `DATABASE_URL`      | `postgresql://deployx:deployx@localhost:5432/deployx`  | server, worker, migrations (local) |
| `REDIS_URL`         | `redis://:deployx-dev-redis@localhost:6379`             | server, worker (local)     |
| `QUEUE_PREFIX`      | `deployx`                                              | server + worker (must match) |
| `DEPLOYMENT_JOB_ATTEMPTS` | `3`                                              | server (job options)       |
| `DEPLOYMENT_JOB_BACKOFF_MS` | `2000`                                         | server (exponential base)  |
| `WORKER_CONCURRENCY` | `2`                                                   | worker                     |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `25000`                                       | worker                     |
| `DEPLOYX_APP_NETWORK` | `deployx-apps`                                    | worker: network for deployed apps |
| `DOCKER_BUILD_TIMEOUT_MS` | `600000`                                     | worker |
| `CONTAINER_STARTUP_GRACE_MS` | `3000`                                    | worker: how long a new container must stay up |
| `HEALTH_CHECK_HOST` | `127.0.0.1` (Compose: `host.docker.internal`)    | worker: host on which published app ports are reachable |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000`                                       | worker: time one health-check request may take |
| `HEALTH_CHECK_INTERVAL_MS` | `2000`                                      | worker: pause between two attempts |
| `HEALTH_CHECK_RETRIES` | `5`                                             | worker: attempts before a deployment is unhealthy |
| `HEALTH_CHECK_STARTUP_GRACE_MS` | `5000`                                 | worker: wait before the first attempt (`0` disables it) |
| `HEALTH_CHECK_ALLOW_PRIVATE_URLS` | `false`                              | worker: allow AWS service URLs that resolve to private/loopback addresses (internal load balancers); link-local/metadata stay refused |
| `GITHUB_WEBHOOK_SECRET` | *(empty: webhooks refused)*                    | **server only**: verifies `X-Hub-Signature-256` of GitHub deliveries |
| `GITHUB_APP_ID` | *(empty)*                                              | worker: GitHub App for private repositories |
| `GITHUB_APP_PRIVATE_KEY` | *(empty)*                                     | worker: the App's PEM key (`\n` for line breaks); never leaves the worker |
| `AWS_REGION` | *(empty: AWS off)*                                        | worker: region of ECR and ECS |
| `AWS_ECR_REPOSITORY` | *(empty)*                                         | worker: ECR repository for all AWS images |
| `AWS_ECS_CLUSTER` | *(empty)*                                            | worker: ECS cluster of the projects' services |
| `AWS_ECS_DEPLOY_TIMEOUT_MS` | `600000`                                   | worker: how long an ECS rollout may take |
| `AWS_ECS_POLL_INTERVAL_MS` | `10000`                                     | worker: how often rollout progress is checked |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE` | *(not set)* | worker: standard AWS SDK credentials, read by the SDK only. Prefer an IAM role. Never stored by DeployX |
| `APP_MEMORY_LIMIT` / `APP_CPU_LIMIT` | `512m` / `1`                       | worker: limits per app container |
| `WORKSPACE_ROOT`    | `<os temp>/deployx-workspaces`                      | worker: where repositories are cloned |
| `DOCKER_SOCKET_GID` | `0`                                                 | Compose: group owning the Docker socket |
| `LOG_STREAM_POLL_MS` | `2000`                                              | server: live streams re-check the database this often (safety net for missed events) |
| `LOG_STREAM_HEARTBEAT_MS` | `15000`                                        | server: keep-alive comment interval on live streams |
| Phase 8: `ALLOW_REGISTRATION`, `SESSION_*`, `PASSWORD_HASH_COST`, `TRUST_PROXY`, `RATE_LIMIT_*`, `LOG_LEVEL`, `LOG_FORMAT`, `METRICS_TOKEN`, `*_SHUTDOWN_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DEPLOYMENT_TIMEOUT_MS`, `RECOVERY_INTERVAL_MS`, `STUCK_DEPLOYMENT_AFTER_MS`, `HEARTBEAT_INTERVAL_MS`, `WORKER_METRICS_*`, `AWS_*_TIMEOUT_MS`, `ALERT_*` | | see [Production configuration](OPERATIONS.md#production-configuration) |
| `POSTGRES_USER`     | `deployx`                                              | postgres container         |
| `POSTGRES_PASSWORD` | `deployx`                                              | postgres container         |
| `POSTGRES_DB`       | `deployx`                                              | postgres container         |
| `REDIS_PASSWORD`    | `deployx-dev-redis`                                    | redis container (`requirepass`); must match `REDIS_URL` |
| `POSTGRES_PORT`     | `5432`                                                 | host port for PostgreSQL   |
| `REDIS_PORT`        | `6379`                                                 | host port for Redis        |
| `TEST_DATABASE_URL` | `DATABASE_URL` + `_test`                               | integration tests only     |

Inside Docker Compose the API, the worker and the migrate job get `DATABASE_URL` and `REDIS_URL` pointing at the `postgres` and `redis` containers automatically.

### Accounts

Every API request (except the probes, `/api/system/status` and webhooks) needs a signed-in session. In development, open the dashboard and **create an account**: the first account while no ADMIN exists becomes ADMIN. Projects created before Phase 8 belong to `dev@deployx.local`; give that user a password with `npm run user:create -- --email dev@deployx.local --role ADMIN` to keep using them, or sign in as the new ADMIN, who sees every project. See [Authentication](SECURITY.md#authentication).

## Testing

The tests start the real Express app on a random port and send HTTP requests to it. The queue tests also run the **real worker in the same process**. Everything is isolated from development data:

- a **separate test database**: `TEST_DATABASE_URL`, or your `DATABASE_URL` with `_test` appended (for example `deployx_test`). It is created if needed, migrated and emptied before each test file.
- a **separate queue prefix** (`deployx-test`), emptied before each test file.
- short timings: the retry backoff is 200 ms, then 400 ms. The queue tests use a fast fake pipeline ([`fakePipeline.js`](../server/test/fakePipeline.js)) instead of Docker.
- the health-check and rollback tests run the worker's real release stage against a fake Docker ([`fakeDocker.js`](../server/test/fakeDocker.js)) whose "containers" are real HTTP servers in the test process, so real health checks hit them.
- the AWS tests replace only the AWS endpoints ([`fakeAws.js`](../server/test/fakeAws.js)): the real ECR/ECS services send real AWS SDK command objects to a fake ECR and ECS, whose services are HTTP servers answering as the image they currently run. **No AWS account or credentials are needed.**

```bash
npm run install:all       # the queue tests load the worker's dependencies too
npm run infra:up          # PostgreSQL + Redis must be running
npm test                  # = npm --prefix server test
```

The default suite (380 tests, about 100 s; last run 2026-10-13: 380 passed; no Docker, AWS or network needed) covers:

- every endpoint with valid requests
- missing and invalid fields, read-only fields, and non-object bodies
- malformed and non-existent IDs for projects and deployments
- duplicate project names and deploying an inactive project
- invalid deployment statuses and log levels
- the schema itself: tables, indexes, foreign keys, CHECK constraints, and cascade on delete
- database failures, which must return a generic `500` without leaking internal details
- **queue:** the job ID, payload and retry options of every queued job; `503` + `FAILED` when the queue is down
- **single job:** the API answers before the job runs, then `QUEUED → BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS` with timestamps and the exact log sequence
- **concurrency:** 4 deployments give 2 running and 2 waiting, never more than 2 active, and jobs 3–4 start only after one of the first two finishes
- **retries:** a job that always fails shows attempts 1, 2 and 3, then `FAILED`; a flaky one succeeds on attempt 3
- **isolation:** a failing job doesn't stop other jobs or the worker
- **duplicates:** adding the same job twice runs it once; a job re-added for a finished deployment, or for a deleted one, is skipped
- **graceful shutdown:** `close()` lets the running job finish and leaves new jobs for the next worker
- **state machine:** every allowed transition passes (`QUEUED → BUILDING`, `BUILDING → DEPLOYING`, `DEPLOYING → HEALTH_CHECK`, `HEALTH_CHECK → SUCCESS / FAILED / ROLLING_BACK`, `ROLLING_BACK → FAILED / ROLLBACK_FAILED`, retry edges); `DEPLOYING → SUCCESS`, `SUCCESS → HEALTH_CHECK`, `SUCCESS → ROLLING_BACK`, `BUILDING → ROLLING_BACK`, `FAILED → ROLLING_BACK`, `FAILED → SUCCESS`, `ROLLING_BACK → SUCCESS`, `HEALTH_CHECK → ROLLBACK_FAILED`, `ROLLBACK_FAILED → anything`, `SUCCESS → BUILDING` and others fail with `DX001`; raw UPDATEs are blocked too; timestamps and no-ops; API 409s with `from`/`to`; the worker stops when a deployment is failed by hand
- **events:** every persisted log line and status change is published on the deployment's own channel, with the database ids and in order; a Redis outage doesn't fail requests
- **live stream (SSE):** headers; stored logs first, then status; new lines and statuses live; a change of the record without a status change (health-check progress) is pushed, once; closes on `SUCCESS`, on `FAILED` and, after staying open through the rollback, on `ROLLBACK_FAILED`; finished deployments get backlog + end at once; unpublished lines still arrive via the periodic check; `Last-Event-ID` resume without duplicates; no leakage between deployments; one shared subscription per deployment, released on disconnect; keep-alives
- **worker units:** image/container naming, workspace isolation, Dockerfile checks (including symlinks), no shell interpretation of hostile arguments, secret-free child environments, clone arguments, build log limits
- **health checks** ([`health-check.test.js`](../server/test/health-check.test.js)): 200, 201 and 204 healthy; 400, 404, 500 and 503 unhealthy; redirects unhealthy and never followed; timeout; connection refused; a non-HTTP server; configurable path; a retry that succeeds; all retries failing; the interval; the startup grace period; bounded attempts; rejected hosts, ports and paths (no request is sent)
- **stable deployments** ([`stable-deployments.test.js`](../server/test/stable-deployments.test.js)): none without a success; the newest success replaces the previous one, whose record stays untouched; failed and rolled-back deployments never become stable; tracked per project; `is_stable` and the rollback fields in the API
- **health check and rollback, end to end** ([`rollback.test.js`](../server/test/rollback.test.js), API → BullMQ → worker → PostgreSQL → Redis → SSE):
  - `SUCCESS` is never reported before the health check passes (two failed attempts, then healthy), and the project's own path is requested
  - version A stable, version B unhealthy → B `FAILED`, rollback `COMPLETED`, A still serving, the exact log sequence, the same lines, `ROLLING_BACK` and the health-check progress on the SSE stream, history and A's record unchanged, no BullMQ retry
  - the recorded health-check details for a pass, a slow start, a failure and a timeout
  - the stable version restarted from its image (by image ID) when its container is gone
  - first deployment unhealthy → `NOT_AVAILABLE`, never `ROLLING_BACK`, no crash
  - rollback failures end as `ROLLBACK_FAILED`: the stable version unhealthy too, its image missing, its container exiting at once; nothing claims a recovery
  - timeouts and refused connections; the worker keeps running afterwards
  - a rollback interrupted by a worker restart
  - **degraded infrastructure:** a browser disconnecting in the middle of a rollback (subscription released, nothing missed after reconnecting); Redis events failing (same database state, the stream falls back to PostgreSQL); PostgreSQL unreachable during the health check (never `SUCCESS` by accident, the attempt is run again, no leaked container)
  - **concurrency:** three projects at once, each rolled back only to its own stable deployment (or to none); in one project a healthy and an unhealthy deployment at the same time, in both orders; two healthy ones leave exactly one container
- **GitHub webhook** ([`github-webhook.test.js`](../server/test/github-webhook.test.js)): valid push; missing, wrong-secret, altered-body, malformed and wrong-format signatures (nothing created); no secret configured (`503`); the payload is only parsed after verification; malformed JSON and invalid payloads with reasons; form-encoded (`415`); `ping`, unsupported and missing events; oversized bodies (`413`); correct branch → a `GITHUB_PUSH` deployment of the exact commit, the same BullMQ job as a manual one, the webhook log lines; other branch, tag, branch deletion, inactive project ignored; unknown repository `404`; case-insensitive repositories with several projects; branches with `/`; commit summaries cleaned; redelivery and **8 simultaneous deliveries → one deployment**; one deployment per project and commit; manual deployments unaffected; no secret or signature in responses or logs
- **project settings** ([`projects.test.js`](../server/test/projects.test.js), [`database.test.js`](../server/test/database.test.js)): `LOCAL` by default; `AWS_ECS` needs its service and URL (create and update); invalid targets, service names and non-origin URLs refused; one ECS service per project (`409`); repository, branch and target changed together; a deployment keeps its target; CHECK constraints and indexes; the migration reverts and re-applies without losing rows
- **GitHub App** ([`github-app.test.js`](../server/test/github-app.test.js)): RS256 JWT verified with the public key; a token for exactly one repository with `contents: read`; not configured / not installed → anonymous; GitHub outages retryable, bad credentials final, invalid key; the **real git** receives the header for `github.com` only, never in its arguments; secrets through stdin
- **AWS services** ([`aws-services.test.js`](../server/test/aws-services.test.js), SDK calls mocked): ECR login with the password on stdin, push under both tags, digest from ECR, missing image, missing repository (final), throttling and push errors (retryable); ECS: a new revision with only the app image changed (sidecar, settings and tags kept), the rollout followed to completion, circuit-breaker failure (also with ECS's own rollback), timeout, replaced deployment, services without a rollout state, missing service/cluster/port (final), throttling vs. access denied; the `AWS_ECS` target's checks; service-URL health checks: address classes, origin-only URLs, the request pinned to the checked address, private/metadata/rebinding refusals without a request
- **GitHub push → AWS, end to end** ([`aws-deploy.test.js`](../server/test/aws-deploy.test.js), webhook → API → BullMQ → worker → ECR → ECS → health check → PostgreSQL → Redis → SSE):
  - push commit A → `BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS`, ECR reference and digest, task definition revision, the service running A by digest, stable, the exact log sequence, the same lines over SSE, no secrets
  - push unhealthy commit B → `ROLLING_BACK → FAILED`, rollback `COMPLETED`: A's **digest** redeployed as a new revision, **A not rebuilt**, A's record untouched except its task definition, history intact, a redelivered push ignored
  - a manual deployment to AWS through the same pipeline
  - first deployment unhealthy (`NOT_AVAILABLE`, service back to its previous task definition); tasks that never start (reverted, retried, `FAILED`, no health check); rollout timeout; ECR push retried; ECR access denied (final); stable image deleted from ECR and stable version unhealthy (`ROLLBACK_FAILED`, no false recovery); AWS settings missing
  - **isolation:** three projects pushed at once, each on its own service with its own images, jobs and event channels; two pushes to one project deployed one after the other; switching a project from `LOCAL` to `AWS_ECS` (no cross-target rollback, local container retired)
- **Phase 8, authentication** ([`auth.test.js`](../server/test/auth.test.js)): scrypt hashes (salted, rehashed when weaker), registration (first account ADMIN exactly once under concurrency, roles never chosen by the client, disabled in production), sign-in with uniform errors, HttpOnly/SameSite cookies, tokens stored hashed and never in bodies or URLs, sign-out, expired and idle sessions, every resource route `401` without a session, `user:create`
- **Phase 8, authorization** ([`authorization.test.js`](../server/test/authorization.test.js)): another user's project, deployments, logs and live stream `403`; lists scoped; ADMIN sees all; operator endpoints ADMIN-only; audit entries and `GET /api/audit-logs`
- **Phase 8, HTTP hardening and rate limits** ([`http-security.test.js`](../server/test/http-security.test.js), [`rate-limit.test.js`](../server/test/rate-limit.test.js)): security headers, CORS allow-list, cross-site requests refused, `415`/`413`, error codes without internals, the production configuration check; sign-in, registration, webhook, deployment, project and API limits, shared through Redis, memory fallback when Redis is down or hangs
- **Phase 8, observability** ([`observability.test.js`](../server/test/observability.test.js), [`worker-monitoring.test.js`](../server/test/worker-monitoring.test.js), [`monitoring.test.js`](../server/test/monitoring.test.js)): request IDs, JSON logs with IDs and without secrets, redaction, liveness vs readiness (database down, shutdown), API and worker metrics from real events, metrics token, heartbeats, the monitoring overview and every alert, scoping per user
- **Phase 8, reliability** ([`deployment-timeouts.test.js`](../server/test/deployment-timeouts.test.js), [`reliability.test.js`](../server/test/reliability.test.js)): deployment timeout kills the running command and fails without retry, cleanup still runs, health checks stop early; AWS and SQL timeouts; recovery of deployments whose job was lost (one worker at a time); Redis outage and recovery for the API; Redis connections killed under a running worker; PostgreSQL failing when a job starts; a worker dying mid-deployment
- **Phase 8, graceful shutdown** ([`graceful-shutdown.test.js`](../server/test/graceful-shutdown.test.js)): on a real server, readiness off, new connections refused, live streams ended, the running request answered, then timers, subscriber, queue and connections closed in that order and exit 0; exit 1 when requests do not finish in time; expired and idle sessions removed on a schedule
- **Phase 8, security regression** ([`security-regression.test.js`](../server/test/security-regression.test.js)): webhook signature bypasses, cross-user access and deployment, SSRF to private and metadata addresses (incl. DNS rebinding), Docker and repository-URL injection, secrets in logs and child environments, invalid state transitions, password/session storage, committed secrets and `VITE_*` variables
- **live stream race** ([`log-stream.test.js`](../server/test/log-stream.test.js)): the last log line, committed together with the final status between the stream's two reads, is still sent before `end` (found by the AWS end-to-end test and fixed in the SSE controller)
- **Phase 9 regressions** (found in the real-environment validation): a paused stable container ends the rollback as `ROLLBACK_FAILED` with the reason *the stable container is paused* ([`rollback.test.js`](../server/test/rollback.test.js)); Redis errors of the worker's recovery queue go through the JSON logger ([`deployment-timeouts.test.js`](../server/test/deployment-timeouts.test.js))

The real-environment validation (real GitHub webhooks, deployments, rollbacks, injected failures, live security checks, backup/restore) is not an automated suite; how it was done and how to repeat it is in [docs/PHASE9_VALIDATION.md](PHASE9_VALIDATION.md).

### Frontend tests

```bash
npm run test:client       # 30 tests, about 2 s (Vitest, jsdom; no API needed)
```

They cover the API client, sign-in and session expiry, nothing stored in the browser, API data rendered as text, the monitoring panel, creating an application and editing its settings (the request sent and the API's validation messages), the empty states, the deployment history's times, and source scans for the security rules; see [Frontend security](SECURITY.md#frontend-security).

### Docker end-to-end tests

These tests run the **real pipeline**: they clone this repository from GitHub, build the [example apps](../examples) with Docker and start containers. They need network access and a Docker daemon, so they're **opt-in**:

```bash
npm run test:docker       # 11 tests, about 2.5 min
```

| Test | Checks |
| ---- | ------ |
| 1. Successful build | commit `d577dab` → full SHA recorded, image `…:d577dab0332a`, container running, health check on a custom path (`/`) passed, stable, `GET /` = `Hello from DeployX`, log sequence, workspace removed |
| Security | container not privileged, no mounts, `CapDrop ALL`, `no-new-privileges`, limits set, only on the app network, ports on 127.0.0.1, no `DATABASE_URL`/`REDIS_URL`/passwords in its env, `postgres` not resolvable from the app network |
| 2 + 6. Invalid Dockerfile + retry | build fails → 3 attempts with 0.2 s / 0.4 s backoff → `FAILED`, parse error stored |
| 3. Missing Dockerfile | `Dockerfile not found at …`, no build, no retry |
| 4. Invalid commit | `Commit … not found on branch main`, no retry |
| 5. Container exits | image builds, container exits → output stored, container removed, `FAILED` after 3 attempts |
| 7. Multiple deployments | 3 deployments, 2 of them concurrent, all `SUCCESS`; exactly one container left, the stable deployment's; history kept with `container_removed_at` |
| 8. Unhealthy first deployment | `unhealthy-app` runs but `GET /health` = 503 → `FAILED`, rollback `NOT_AVAILABLE`, one attempt, container removed |
| 9. Rollback | `hello-app` stable, then `unhealthy-app` → `FAILED`, rollback `COMPLETED`; the stable container never stopped and still answers; log sequence |
| 10. Restore from the image | stable container removed by hand → the rollback starts it again from its image **ID** (the commit tag meanwhile points at the unhealthy build) and health-checks it |
| 11. Rollback failure | stable container and image removed → `ROLLBACK_FAILED` with the reason; history intact |

They use their own image prefix (`deployx-test/`) and network (`deployx-apps-test`), and they remove everything they created. They clone the `main` branch; set `DEPLOYX_TEST_BRANCH` to test example apps from another branch. Since Phase 7 they run through the deployment-target pipeline (`LOCAL`) and pass unchanged, which shows that the local Docker path behaves exactly as before.

**No test needs AWS.** To try a real AWS deployment, set up ECR and ECS as in [AWS deployment architecture](DEPLOYMENT_LIFECYCLE.md#aws-deployment-architecture), give the worker `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_ECS_CLUSTER` and credentials, point a project at its service, and deploy `examples/hello-app` (port 3000) and then `examples/unhealthy-app` to see the rollback.

### Manual verification with Docker

Follow [Local setup and the test repository](DEPLOYMENT_LIFECYCLE.md#local-setup-and-the-test-repository) to deploy `hello-app`, then try the failing examples: `examples/crash-app/Dockerfile`, `examples/broken-dockerfile/Dockerfile`, a non-existent `dockerfile_path`, or a `commit_sha` that doesn't exist. For health checks and rollback, follow [How to test locally](DEPLOYMENT_LIFECYCLE.md#how-to-test-locally). Useful commands:

```bash
docker compose logs -f worker                                   # jobs starting, retrying, completing
docker ps --filter label=deployx.managed=true                   # running app containers
docker compose stop worker                                      # graceful: waits for the running job
```

To try the API by hand, sign in with `curl` as shown in [Calling the API from the command line](API.md#calling-the-api-from-the-command-line). Through the dashboard's proxy, `http://localhost:3000/api/...` works too.
