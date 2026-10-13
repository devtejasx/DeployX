# Architecture

DeployX is three Node.js processes around two stores: a **React dashboard**, an **Express API** that owns every write, and a **deployment worker** that does the slow work (clone, build, run, health check, rollback). **PostgreSQL** is the source of truth; **Redis** carries the BullMQ job queue, live log events, rate-limit counters and worker heartbeats.

See also: [Deployment lifecycle](DEPLOYMENT_LIFECYCLE.md) for what a deployment goes through, [Security](SECURITY.md), [Operations](OPERATIONS.md) and the [API reference](API.md).

## System overview

```text
                ┌──────────────────────────┐
  Browser ────▶ │  client  (React + Vite)  │  :3000
                └────────────┬─────────────┘
                             │  /api/*  (dev proxy)
                             ▼
                ┌──────────────────────────┐   push webhook (signed)   ┌────────────┐
                │  server  (Express API)   │◀──────────────────────────│   GitHub   │
                │  routes → controllers →  │  POST /api/webhooks/github└─────┬──────┘
                │  services → db / queues  │                                 │
                └──────┬────────────┬──────┘                                 │
                       │            │ add job (BullMQ)                       │
                  SQL  │            ▼                                        │
                       │       ┌──────────┐                                  │
                       │       │  Redis   │  :6379   "deployments" queue     │
                       │       └────┬─────┘                                  │
                       │            │ next job (BullMQ, concurrency 2)       │
                       │            ▼                                        │
                       │  ┌──────────────────────────┐  git clone <sha>      │
                       │  │  worker  (Node.js)       │◀──────────────────────┘ (GitHub App token for private repos)
                       │  └──────┬─────────────┬─────┘
                       ▼         │ status+logs │ docker build, then by deployment target
             ┌──────────────┐    │       LOCAL ├────────────────────────────────┐ AWS_ECS
             │  PostgreSQL  │◀───┘             ▼                                ▼
             │    :5432     │      ┌────────────────────────────┐  ┌──────────────────────────┐
             └──────▲───────┘      │ Docker daemon              │  │ Amazon ECR               │
                    │              │  network "deployx-apps"    │  │  <project>-<id>-<sha12>  │
             ┌──────┴───────┐      │   └── app containers       │  │ Amazon ECS service       │
             │   migrate    │      │       127.0.0.1:<port>     │  │  <repository>@<digest>   │
             └──────────────┘      └────────────────────────────┘  └──────────────────────────┘
                                   then an HTTP health check (container port or service URL) → SUCCESS or rollback
```

The browser only talks to the client. The Vite dev server forwards `/api/*` requests to the API, so the frontend never contains a hard-coded backend URL. Running deployments are followed over **Server-Sent Events** (`/api/deployments/:id/logs/stream`); the API learns about new log lines and status changes from **Redis Pub/Sub** events that the worker publishes (see [Real-Time Deployment Logs](DEPLOYMENT_LIFECYCLE.md#real-time-deployment-logs)).

Once a container runs, the worker requests the project's health-check path on the container's published port. A healthy answer makes the deployment `SUCCESS` and retires the previous container; an unhealthy one triggers a rollback to the last stable deployment (see [Health checks and automatic rollback](DEPLOYMENT_LIFECYCLE.md#health-checks-and-automatic-rollback)).

A deployment can also come from a **GitHub push webhook**, and it can run on **Amazon ECS** instead of the local Docker host. Both are ways into, and a target of, the **same pipeline**: the webhook only creates the deployment and queues it, and the AWS target plugs into the same build, health check and rollback (see [GitHub integration and AWS deployment](DEPLOYMENT_LIFECYCLE.md#github-integration-and-aws-deployment)). The AWS target is tested only against fake AWS endpoints; it has not been run against a real AWS account.

Every request except the probes, the public system status and the webhook needs a signed-in session, and every project, deployment and log is checked against its owner (see [Security](SECURITY.md)).

Each API request passes through these layers:

| Layer | Folder | Responsibility |
| ----- | ------ | -------------- |
| Security | `middleware/security.js`, `rateLimit.js`, `auth.js`, `requestContext.js` | headers, CORS, cross-site checks, rate limits, session, request IDs |
| Routes | `routes/` | URL + HTTP method → middleware chain |
| Validation | `middleware/validation.js`, `validators/` | reject bad IDs and bodies before any SQL runs |
| Controllers | `controllers/` | translate HTTP ⇄ service calls, pick the status code |
| Services | `services/` | business rules and parameterized SQL |
| DB | `db/` | connection pool, Redis client, migrations |
| Queues | `queues/` | BullMQ producer for deployment jobs |

## Technology stack

| Layer          | Technology                                   |
| -------------- | -------------------------------------------- |
| Frontend       | React 19, Vite 8 (no UI library; plain CSS with light and dark themes) |
| Backend        | Node.js (≥ 20.12), Express 5, Helmet, `cors`, `express-rate-limit` |
| Validation     | zod 4                                        |
| Database       | PostgreSQL 17 (`pg` driver)                  |
| Migrations     | node-pg-migrate 9 (plain SQL files)          |
| Cache / queue  | Redis 7, BullMQ 6, `ioredis` 5               |
| Observability  | JSON logs, Prometheus metrics (`prom-client`), alert rules in [`monitoring/`](../monitoring) |
| Tests          | Node.js built-in test runner (`node:test`) for the API and worker; Vitest + Testing Library (jsdom) for the dashboard |
| Worker         | Node.js, BullMQ 6, `ioredis`, `pg`, `git`, Docker CLI (BuildKit) |
| Cloud          | AWS SDK for JavaScript v3 (`@aws-sdk/client-ecr`, `@aws-sdk/client-ecs`): Amazon ECR, Amazon ECS (Fargate or EC2) |
| GitHub         | push webhooks (HMAC-SHA256), GitHub App installation tokens (`node:crypto` RS256 JWT, no extra library) |
| Local infra    | Docker, Docker Compose                       |

## Data model

### Relationships

```text
users ─── 1:N  sessions.user_id → users.id          ON DELETE CASCADE
  │   └── 1:N  audit_logs.user_id → users.id        ON DELETE SET NULL (entries outlive their user)
  │
  │ 1:N   projects.user_id → users.id              ON DELETE CASCADE
  ▼
projects
  │
  │ 1:N   deployments.project_id → projects.id     ON DELETE CASCADE
  ▼
deployments
  │
  │ 1:N   deployment_logs.deployment_id → deployments.id   ON DELETE CASCADE
  ▼
deployment_logs
```

Every foreign key except the audit log's cascades. **Deleting a project deletes all of its deployments and their logs in the same statement**, so no orphan rows can remain. A deployment or its logs have no meaning without their project. Deleting a user removes that user's projects in the same way.

### Tables

**`users`**

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `name` | `varchar(100)` | not blank |
| `email` | `varchar(255)` | **unique**, stored lower-case |
| `password_hash` | `varchar(255)` | `scrypt$N$r$p$salt$hash` (CHECK); `NULL` = cannot sign in |
| `role` | `varchar(10)` | `ADMIN` \| `USER` (CHECK), default `USER` |
| `last_login_at` | `timestamptz` | |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` maintained by a trigger |

**`sessions`**: one row per signed-in browser. Only the SHA-256 of the 256-bit cookie token is stored (`token_hash`), with `ip`, `user_agent`, `created_at`, `last_seen_at` (idle timeout) and `expires_at` (absolute lifetime). Expired sessions are removed on a schedule.

**`audit_logs`**: append-only record of security-sensitive actions: `user_id`, `action` (`project.created`, `auth.login_failed`, `webhook.rejected`…), `target_type`, `target_id`, `ip`, `request_id`, `details` (`jsonb`, never credentials), `created_at`. See [Audit log](SECURITY.md#audit-log).

**`projects`**

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `uuid` | primary key |
| `user_id` | `uuid` | FK → `users.id` |
| `name` | `varchar(100)` | unique per user |
| `description` | `varchar(1000)` | nullable |
| `github_repo` | `varchar(255)` | `https://github.com/<owner>/<repo>` |
| `github_branch` | `varchar(255)` | default `main` |
| `dockerfile_path` | `varchar(255)` | default `Dockerfile` |
| `container_port` | `integer` | port the app listens on in its container, 1–65535; required by the API (nullable only for pre-Phase-4 rows) |
| `health_check_path` | `varchar(255)` | path requested to check the app's health, default `/health`; an absolute path with an optional query string (CHECK) |
| `deployment_target` | `varchar(20)` | where deployments run: `LOCAL` \| `AWS_ECS` (CHECK), default `LOCAL` |
| `aws_ecs_service` | `varchar(255)` | the project's ECS service (`AWS_ECS`); letters, digits, `-`, `_`; one project per service (unique while `AWS_ECS`) |
| `aws_service_url` | `varchar(255)` | origin the ECS service answers on, e.g. `https://my-app.example.com` (no credentials, path or query; CHECK). Required with `aws_ecs_service` for `AWS_ECS` (CHECK) |
| `status` | `varchar(20)` | `ACTIVE` \| `INACTIVE` (CHECK), default `ACTIVE` |
| `created_at`, `updated_at` | `timestamptz` | |

**`deployments`**

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `uuid` | primary key |
| `project_id` | `uuid` | FK → `projects.id` |
| `commit_sha` | `varchar(40)` | nullable; 7–40 lower-case hex (CHECK) |
| `branch` | `varchar(255)` | |
| `status` | `varchar(20)` | `QUEUED` \| `BUILDING` \| `DEPLOYING` \| `HEALTH_CHECK` \| `ROLLING_BACK` \| `SUCCESS` \| `FAILED` \| `ROLLBACK_FAILED` (CHECK), default `QUEUED` |
| `trigger` | `varchar(20)` | what created it: `MANUAL` (API/dashboard) \| `GITHUB_PUSH` (webhook), default `MANUAL`. A `GITHUB_PUSH` deployment always has a full 40-character `commit_sha` (CHECK) |
| `deployment_target` | `varchar(20)` | the project's target when the deployment was created: `LOCAL` \| `AWS_ECS`; it deploys and rolls back there even if the project is changed meanwhile |
| `docker_image` | `varchar(255)` | the image version: `deployx/my-api-0f8fad5b:abc123def456` locally, the ECR reference `<account>.dkr.ecr.<region>.amazonaws.com/<repository>:my-api-0f8fad5b-abc123def456` on AWS |
| `docker_image_id` | `varchar(80)` | immutable ID (`sha256:…`) of the local image; what a local rollback starts again. Internal, not returned by the API |
| `image_digest` | `varchar(71)` | manifest digest (`sha256:…`) of the image in ECR (`AWS_ECS`): what ECS runs and an AWS rollback restores |
| `aws_task_definition_arn` | `varchar(1024)` | the ECS task definition revision the deployment runs as (`AWS_ECS`) |
| `container_id`, `container_name` | `varchar` | the container started for this deployment |
| `host_port` | `integer` | host port (on 127.0.0.1) the container port is published on |
| `container_removed_at` | `timestamptz` | when the container was removed (e.g. replaced by a newer deployment) |
| `error_message` | `varchar(2000)` | short reason for a `FAILED` deployment |
| `health_check` | `jsonb` | what the worker recorded while checking the application: `status` (`RUNNING` \| `PASSED` \| `FAILED`), `attempts`, `max_attempts`, `status_code`, `response_time`, `error`, `started_at`, `completed_at`; `NULL` until the deployment reaches its health check |
| `rollback_status` | `varchar(20)` | outcome of the automatic rollback: `COMPLETED` \| `FAILED` \| `NOT_AVAILABLE` (CHECK); `NULL` unless the deployment failed its health check |
| `rollback_deployment_id` | `uuid` | FK → `deployments.id` (`ON DELETE SET NULL`): the stable deployment the rollback restored, or tried to |
| `started_at`, `finished_at` | `timestamptz` | set from status changes (see below) |
| `created_at`, `updated_at` | `timestamptz` | |

**`deployment_logs`**

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `bigint` identity | primary key; gives a stable chronological order |
| `deployment_id` | `uuid` | FK → `deployments.id` |
| `level` | `varchar(10)` | `INFO` \| `WARN` \| `ERROR` (CHECK) |
| `message` | `text` | 1–10000 characters |
| `created_at` | `timestamptz` | |

The allowed values are enforced twice: the API validates requests, and PostgreSQL CHECK constraints reject invalid rows even if they bypass the API.

There is no "stable" column. The API's `is_stable` field is derived by `stable_deployment_id(project_id)`: a project's most recently finished `SUCCESS` deployment (see [Stable deployments](DEPLOYMENT_LIFECYCLE.md#stable-deployments)).

### Indexes

| Index | Serves |
| ----- | ------ |
| `users_email_key` (unique) | look up a user by email |
| `projects_user_id_name_key` (unique `user_id, name`) | "projects of this user", and per-user unique names |
| `deployments_project_id_created_at_idx` (`project_id, created_at DESC`) | "deployments of a project, newest first" |
| `deployment_logs_deployment_id_id_idx` (`deployment_id, id`) | "logs of a deployment in order" |
| `deployments_stable_idx` (`project_id, finished_at DESC`, only `SUCCESS` rows) | "the last stable deployment of a project" |
| `deployments_github_push_commit_key` (unique `project_id, commit_sha`, only `GITHUB_PUSH` rows) | webhook duplicate protection: one push deployment per project and commit |
| `projects_github_repo_lower_idx` (`lower(github_repo)`) | the webhook's "projects of this repository" lookup (GitHub names are case-insensitive) |
| `projects_aws_ecs_service_key` (unique `aws_ecs_service`, only `AWS_ECS` rows) | two projects can never deploy to the same ECS service |
| `sessions_token_hash_key` (unique), `sessions_user_id_idx`, `sessions_expires_at_idx` | session lookup by cookie, sign-out of a user, removal of expired sessions |
| `audit_logs_created_at_idx`, `audit_logs_user_id_created_at_idx` | the audit log, newest first, overall and per user |
| `deployments_unfinished_idx` (`updated_at`, only unfinished rows) | the stuck-deployment check and the monitoring overview |
| `deployments_finished_at_idx` (`finished_at`, only finished rows) | the monitoring overview's 24-hour outcome counts |

No separate index is needed on `projects.user_id`, because the unique `(user_id, name)` index already covers lookups that start with `user_id`.

### Migrations

Migrations are plain SQL files in [`server/src/db/migrations`](../server/src/db/migrations), each with an `-- Up Migration` and a `-- Down Migration` section. [node-pg-migrate](https://github.com/salsita/node-pg-migrate) records applied files in the `pgmigrations` table and takes an advisory lock, so two processes cannot migrate at the same time.

```bash
# From the repository root (uses DATABASE_URL from the root .env)
npm run migrate                         # apply all pending migrations
npm run migrate:down                    # revert the most recent migration (see the warning below)
npm --prefix server run migrate:create -- add-something   # new empty SQL migration file

# With Docker Compose
docker compose run --rm migrate         # apply pending migrations
```

| Migration | Adds |
| --------- | ---- |
| `1790330478769_create-core-schema` | `users`, `projects`, `deployments`, `deployment_logs`, indexes, triggers |
| `1790587019517_add-container-tracking` | `projects.container_port`; `deployments.container_id`, `container_name`, `host_port`, `container_removed_at`, `error_message` |
| `1790671094193_deployment-state-machine` | `deployment_status_transitions` (the transition map), the enforcing trigger, `transition_deployment_status()` |
| `1790767006154_rollback-and-stable-deployments` | `ROLLING_BACK` status and its transitions; `deployments.rollback_status`, `rollback_deployment_id`; `projects.health_check_path`; `stable_deployment_id()` and its index |
| `1790767291227_health-check-required-and-image-id` | removes `DEPLOYING → SUCCESS` (success requires the health check); `deployments.docker_image_id` |
| `1790775116221_rollback-failed-status-and-health-check-details` | `ROLLBACK_FAILED` status and `ROLLING_BACK → ROLLBACK_FAILED`; `transition_deployment_status()` treats it as final; `deployments.health_check` |
| `1790787875864_github-push-and-aws-targets` | `projects.deployment_target`, `aws_ecs_service`, `aws_service_url`; `deployments.trigger`, `deployment_target`, `image_digest`, `aws_task_definition_arn`; the push-duplicate, repository and ECS-service indexes. Existing rows become `MANUAL` / `LOCAL`; reversible |
| `1790880000000_authentication-audit-and-monitoring` | `users.password_hash`, `role`, `last_login_at`; `sessions`; `audit_logs`; the two monitoring indexes on `deployments` |

`docker compose up` runs the `migrate` service automatically, and the API starts only after it has finished successfully.

**Reverting is not a recovery tool.** Each down step drops what its migration added: reverting the newest one deletes every password hash, role, session and the whole audit log. Recover from a bad migration by restoring the backup taken before it (see [Backup and recovery](OPERATIONS.md#backup-and-recovery)).

## Deployment jobs (BullMQ)

### Flow

```text
POST /api/projects/:projectId/deployments
 │
 ▼
API ── 1. validate project (exists, ACTIVE)
 │     2. INSERT deployment (status QUEUED) + log "Deployment created"
 │     3. add job to BullMQ   (jobId = deployment ID)
 │     4. respond 201 { deployment, jobId }       ← returns in ~20 ms
 ▼
BullMQ
 │
 ▼
Redis  ── queue "deployments" (keys under QUEUE_PREFIX, default "deployx")
 │
 ▼
Worker ── up to WORKER_CONCURRENCY jobs at a time (default 2)
 │        QUEUED → BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS   (or ROLLING_BACK → FAILED)
 ▼
PostgreSQL ── deployments.status / started_at / finished_at + deployment_logs
```

The API never does deployment work itself. It stores the record, queues the job and returns. The only coupling between the API and the worker is the queue (name `deployments`, job name `deploy`, and the shared `QUEUE_PREFIX`) plus the shared PostgreSQL tables.

### Job payload

```json
{ "deploymentId": "69bb15c5-…", "projectId": "391710c4-…", "commitSha": "abc1234", "branch": "main" }
```

The payload contains identifiers only, no credentials. The worker reads everything else from PostgreSQL.

### Job lifecycle

`deploymentProcessor.js` ([source](../worker/src/processors/deploymentProcessor.js)) is a generic runner. It loads the deployment and its project, skips duplicates, logs `Deployment job started (attempt n of m)` and records failed attempts. It hands the actual work to a **pipeline**: in production, [`dockerDeployment.js`](../worker/src/pipeline/dockerDeployment.js), described in [Docker deployments](DEPLOYMENT_LIFECYCLE.md#docker-deployments) along with a full log trace.

### Retries

| Setting | Value | Configured by |
| ------- | ----- | ------------- |
| Attempts | 3 (first run included) | `DEPLOYMENT_JOB_ATTEMPTS` (API) |
| Backoff | exponential: 2 s, then 4 s | `DEPLOYMENT_JOB_BACKOFF_MS` (API) |

When an attempt fails:

1. The worker logs `ERROR Attempt n of 3 failed: <reason>`.
2. If attempts remain, the deployment goes back to **`QUEUED`** and gets `WARN Retrying in 2s (attempt 2 of 3)`. `started_at` keeps the time of the first attempt. BullMQ re-runs the job after the backoff.
3. After the last attempt, the deployment becomes **`FAILED`** (with `finished_at`) and gets `ERROR Deployment failed after maximum retry attempts`. The BullMQ job ends in its `failed` state.

Some errors can't be fixed by trying again, so they fail right away without retries: a missing repository, branch, commit or Dockerfile, a deployment deleted while its job ran, or an unknown job name. The [failure table](DEPLOYMENT_LIFECYCLE.md#failure-handling-and-retries) lists which failures are retried.

### Failure handling

- An error in one job is caught by BullMQ and handled as described above. Other jobs and the worker process carry on.
- If the worker can't write its failure logs (for example, PostgreSQL is briefly unavailable), it logs that to the console and still reports the original error to BullMQ, so retries keep working.
- A `failed` event handler catches jobs that BullMQ fails outside the processor, such as a job that stalled too often. The deployment is still marked `FAILED`. A deployment that already has a final status is never overwritten.
- **Queue unavailable:** if the API can't add the job (Redis down, 3 s timeout), it marks the new deployment `FAILED`, logs `Could not add the deployment job to the queue`, and returns **503**. Otherwise the deployment would sit in `QUEUED` with no job to pick it up.

### Concurrency

```text
WORKER_CONCURRENCY=2

Job A ──► Worker  (running)
Job B ──► Worker  (running)
Job C ──► Redis   (waiting)
Job D ──► Redis   (waiting)   → C and D start as A or B finish
```

To handle more load, run more worker containers (`docker compose up --scale worker=3`). Each one takes jobs from the same queue. There is no autoscaling.

### Duplicates and idempotency

- **Job ID = deployment ID.** BullMQ stores at most one job per ID, so adding the same deployment again while its job exists (waiting, running, retrying or kept after finishing) returns the existing job instead of creating a second one.
- **Final deployments are never redone.** Finished jobs are removed after a while (completed: 24 h / 1000 jobs, failed: 7 days). If a job for the same deployment is added after that, the worker sees the deployment is already `SUCCESS` or `FAILED` and completes the job without doing anything.
- **Deleted deployments are skipped.** If the project was deleted before the job ran, the job completes and is marked as skipped.
- Besides BullMQ's job locks, the worker holds a PostgreSQL advisory lock per project while it releases or rolls back, so two deployments of one project never retire each other's containers. The ADMIN-only manual status change (`PATCH /api/deployments/:id/status`) goes through the state machine but is not coordinated with a running job.

### Redis connections

- **API:** a single ioredis connection ([`server/src/db/redis.js`](../server/src/db/redis.js)), used by both `/api/system/status` and the BullMQ queue. Commands fail fast while disconnected.
- **Worker:** one ioredis connection ([`worker/src/config/redis.js`](../worker/src/config/redis.js)), which BullMQ duplicates once for its blocking "wait for next job" call.
- Everything comes from `REDIS_URL`. There are no hard-coded hosts or credentials.

### Worker startup and shutdown

```bash
npm run dev:worker                 # local, with .env
docker compose up -d worker        # in Docker
```

On startup the worker connects to Redis and PostgreSQL and logs:

```text
DeployX Worker started (development, pid 1) - queue "deployments", concurrency 2
```

On `SIGTERM` or `SIGINT` (for example, `docker compose stop worker`) it:

1. stops taking new jobs,
2. **waits for running jobs to finish**,
3. closes Redis and PostgreSQL, logs `DeployX Worker stopped`, and exits with code 0.

If running jobs don't finish within `WORKER_SHUTDOWN_TIMEOUT_MS` (25 s), the worker exits with code 1. Their locks expire, and BullMQ hands the jobs to the next worker that starts. Compose gives the worker a 30 s `stop_grace_period` so this timeout gets to run.

```text
worker-1  | [worker] job a89d07b9-… started (attempt 1 of 3)
worker-1  | DeployX Worker received SIGTERM, finishing running jobs before exit
worker-1  | [worker] job a89d07b9-… completed
worker-1  | DeployX Worker stopped
```

## Dashboard

`http://localhost:3000` (Compose) shows a sign-in form until a session exists. Signed in, it has five areas, top to bottom:

- **System status**: API, PostgreSQL and Redis, from the public `GET /api/system/status`.
- **Monitoring**: alerts, applications by state, workers and their heartbeats, the queue, the last 24 hours, deployments in progress and recent failures, refreshed every 5 s from `GET /api/monitoring/overview`. A source the API could not read is shown as unavailable, never as zero. See [Deployment monitoring](OPERATIONS.md#deployment-monitoring-dashboard).
- **Applications**: your applications (an ADMIN sees all), each with `owner/repo · branch` and an **AWS** tag when it deploys to ECS. **New** opens a form for the name, repository, branch, Dockerfile path, container port and health-check path; the API validates it and its messages are shown as they are.
- **Deployment history** of the selected application, **newest first**: number (`#1` = oldest), short ID, commit, trigger (Manual / GitHub push), target (Local Docker / AWS ECS), status badge, a **Stable** tag on the live version, the rollback outcome ("Automatic rollback completed · restored #1"), the error, and the created, started and finished times with the duration. **Deploy** queues the branch head. The list refreshes every 3 s while something is running, and at once when the selected deployment changes status. **Settings** edits the repository, branch, Dockerfile path, container port, health-check path and deployment target (Local Docker, or AWS ECS with its service and service URL), and lists the GitHub webhook settings, naming the secret only by its variable.
- **Deployment details**:
  - the lifecycle steps `QUEUED → BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS` (or the failed step), and, while it runs, what it is doing with the latest log line (**Running health checks…** / `Health check attempt 2/5 failed: Health check returned HTTP 503`);
  - trigger, repository, branch, the commit as a link to GitHub, target, timestamps and a ticking duration, the image version (the ECR reference on AWS), the image digest, the container (or the ECS task definition), and the local URL of a running container;
  - a **Health check** box (Running / Passed / Failed, `Attempt 3 / 5`, the last response such as `503 Service Unavailable · 9 ms`, the last error);
  - an **Automatic rollback** box for a failed health check: `✓ Completed` with a link to the restored deployment, `✗ Failed`, or `Not available` when there was no stable version;
  - **live logs** over Server-Sent Events that follow new lines (scroll up to pause) and show whether the stream is Live, Reconnecting or closed.

None of this is computed in the browser: steps, boxes and tags are read from `status`, `health_check`, `rollback_status`, `rollback_deployment_id` and `is_stable` as the API sends them, and the UI keeps no second copy of deployment status. The selection is in the URL (`#/projects/<id>/deployments/<id>`), so reloads and links keep it. The page follows the system's light or dark theme; below 1200 px the applications go above the history so that every column of the history fits, and it works down to phone width. Accessibility: text meets WCAG AA contrast in both themes (checked by a test that computes it from `index.css`), a **Skip to applications** link is the first keyboard stop, form hints are tied to their fields with `aria-describedby`, and screen readers hear the activity line, the stream state and the final outcome rather than every log line. Screenshots are in the [demo guide](DEMO_GUIDE.md#screenshots).

## Repository layout

```text
DeployX/
├── client/                         # React dashboard (Vite)
│   ├── public/
│   ├── src/
│   │   ├── api/                    # http.js (envelope), systemApi.js, deploymentsApi.js, authApi.js, monitoringApi.js
│   │   ├── components/             # SignIn, Monitoring, SystemStatus, ProjectList, NewProject, ProjectSettings, DeploymentHistory,
│   │   │                           # DeploymentDetails, HealthCheckSummary, RollbackSummary, LogViewer,
│   │   │                           # StatusSteps, StatusBadge, StatusRow
│   │   ├── hooks/                  # useAuth, useDeploymentStream (SSE), usePolling, useHashRoute, useSystemStatus
│   │   ├── utils/format.js         # dates, durations, short ids
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── test/                       # frontend tests (Vitest, Testing Library, jsdom)
│   ├── vite.config.js              # dev server on :3000, /api proxy; preview with the security headers; test config
│   ├── nginx.conf.template         # production image: static files + /api proxy
│   ├── security-headers.conf       # production CSP and headers
│   └── Dockerfile                  # targets: development (Vite) and production (nginx)
│
├── server/                         # Express API
│   ├── src/
│   │   ├── config/index.js         # environment configuration
│   │   ├── controllers/            # health, system, project, deployment, log, logStream, webhook
│   │   ├── routes/                 # one router per resource + index.js; webhook.routes.js (raw body)
│   │   ├── services/               # business logic + SQL (project, deployment, log, user, systemStatus);
│   │   │                           # githubWebhook.service.js: signature, push parsing, queueDeployment()
│   │   │                           # password.js (scrypt), session.service.js, auth.service.js, access.js (RBAC),
│   │   │                           # audit.service.js, monitoring.service.js (overview + alerts), metricsCollectors.js
│   │   ├── lib/                    # logger.js (JSON, redaction), metrics.js (prom-client), lifecycle.js, shutdown.js
│   │   ├── scripts/createUser.js   # npm run user:create
│   │   ├── validators/             # zod schemas for request bodies
│   │   ├── middleware/
│   │   │   ├── validation.js       # validate({ params, query, body })
│   │   │   ├── auth.js             # authenticate (session cookie), requireAuth, requireRole
│   │   │   ├── security.js         # Helmet, CORS allow-list, cross-site check, JSON-only bodies
│   │   │   ├── rateLimit.js        # rate limits in Redis, memory fallback
│   │   │   ├── requestContext.js   # request IDs, request logs and metrics
│   │   │   ├── notFound.js
│   │   │   └── errorHandler.js     # single error format, DB error mapping
│   │   ├── utils/                  # ApiError, sendSuccess, github.js (repository URL parsing)
│   │   ├── db/
│   │   │   ├── postgres.js         # pool + query()
│   │   │   ├── redis.js            # the API's single ioredis connection
│   │   │   ├── migrate.js          # migration runner (CLI + programmatic)
│   │   │   └── migrations/         # versioned SQL
│   │   ├── queues/
│   │   │   └── deploymentQueue.js  # BullMQ producer: enqueueDeployment()
│   │   ├── app.js                  # Express app
│   │   └── server.js               # entry point: listen + graceful shutdown
│   ├── test/                       # integration, queue, unit and Docker e2e tests (node:test)
│   └── Dockerfile
│
├── worker/                         # deployment worker
│   ├── src/
│   │   ├── index.js                # entry point: start, SIGTERM/SIGINT shutdown
│   │   ├── worker.js               # BullMQ Worker, concurrency, event handlers
│   │   ├── processors/
│   │   │   └── deploymentProcessor.js  # job runner: idempotency, attempts, failure bookkeeping, resuming interrupted attempts
│   │   ├── pipeline/
│   │   │   ├── dockerDeployment.js     # the one pipeline: build → target.publish → target.deploy → release
│   │   │   ├── build.js                # workspace → GitHub App token → clone → checkout → Dockerfile → docker build
│   │   │   └── release.js              # health check → SUCCESS and retire the previous version, or rollback
│   │   ├── targets/
│   │   │   ├── index.js                # LOCAL and AWS_ECS, by deployments.deployment_target
│   │   │   ├── localDockerTarget.js    # docker run, container health target, restore container/image
│   │   │   └── awsEcsTarget.js         # ECR push, ECS rollout, service-URL health target, restore by digest
│   │   ├── services/
│   │   │   ├── deploymentService.js    # status + logs + container/image/task tracking + stable lookup in PostgreSQL
│   │   │   ├── healthCheckService.js   # HTTP health checks (container port or service URL, SSRF guard); retries
│   │   │   ├── rollbackService.js      # restore and verify the last stable deployment, through the target
│   │   │   ├── gitService.js           # safe clone + exact commit checkout (token via git's environment)
│   │   │   ├── githubAppService.js     # GitHub App JWT → repository-scoped read-only installation token
│   │   │   ├── dockerService.js        # image/container naming, build, restricted run, tag/push/login
│   │   │   ├── ecrService.js           # Amazon ECR: login, push by tag, digest lookup
│   │   │   ├── awsDeploymentService.js # Amazon ECS: task definition revision, UpdateService, rollout wait
│   │   │   ├── workspace.js            # per-deployment workspace, path + Dockerfile checks
│   │   │   ├── heartbeat.js            # worker heartbeat in Redis
│   │   │   └── recoveryService.js      # ends deployments whose job was lost
│   │   ├── lib/
│   │   │   ├── exec.js                 # spawn without a shell, env allowlist, timeouts, stdin for secrets
│   │   │   ├── buildLog.js             # build output filtering and limits
│   │   │   ├── awsErrors.js            # AWS SDK errors → retryable or final, readable messages
│   │   │   ├── errors.js               # RecordedFailureError: failed for good, already recorded
│   │   │   ├── jobContext.js           # the running job's timeout signal (AsyncLocalStorage)
│   │   │   ├── logger.js               # JSON logs with redaction (same as the API's)
│   │   │   └── metrics.js              # worker Prometheus metrics
│   │   ├── monitoringServer.js         # worker /health, /ready, /metrics
│   │   ├── config/
│   │   │   ├── index.js            # environment configuration
│   │   │   └── redis.js            # ioredis connection factory
│   │   └── db/postgres.js          # pool, query(), per-project advisory lock
│   └── Dockerfile                  # adds git + Docker CLI (buildx)
│
├── examples/                       # test apps for deployments (hello-app, unhealthy-app, crash-app, broken-dockerfile, validation-app)
├── docs/                           # architecture, lifecycle, security, operations, setup, API, demo, troubleshooting,
│                                   # development history, the Phase 9 validation report, screenshots/
├── scripts/demo.mjs                # npm run demo: healthy deploy → unhealthy deploy → automatic rollback
├── monitoring/                     # prometheus.yml, alert-rules.yml, alertmanager.example.yml
├── docker-compose.yml
├── .env.example                    # development settings
├── .env.production.example         # production settings (placeholders only)
└── package.json                    # convenience scripts for the whole repo
```
