# DeployX

A self-service deployment platform: connect a GitHub repository, build it into a Docker image, deploy it, watch it run and roll back automatically when a release goes bad.

> **Status: Phase 6 of 8. Health checks and automatic rollback.** DeployX is being built one phase at a time. Creating a deployment queues a job; the worker clones the public GitHub repository at the requested commit, builds a Docker image and starts it as a container on an isolated network. It then **checks the application's health over HTTP**: only a healthy deployment becomes `SUCCESS`, and an unhealthy one is **rolled back to the last stable version automatically**. Every status change goes through a database-enforced state machine, and the dashboard shows each application's deployment history with **live logs over Server-Sent Events**. GitHub/AWS integration (Phase 7) and production-grade isolation (Phase 8) come later. See [Security measures and limitations](#security-measures-and-limitations-development-setup) before deploying code you don't trust.

## Overview

**Phase 1 (foundation)**

- A **React dashboard** that shows the live health of the system
- An **Express API** with health and system-status endpoints
- **PostgreSQL** and **Redis**, with verified connections from the API
- A **worker** process that later phases will use for background deployment jobs
- **Docker Compose**, which runs the whole stack with one command

**Phase 2 (database and REST API)**

- Versioned **SQL migrations** for `users`, `projects`, `deployments` and `deployment_logs`
- **Project CRUD** at `/api/projects`
- **Deployment records**: create (always `QUEUED`), list, fetch and update status
- **Deployment logs**: add and read log lines
- **Validation** for every request body and ID, and a single response format across the API
- An **integration test suite** that runs against a real PostgreSQL database

**Phase 3 (job queue and worker)**

- A **BullMQ `deployments` queue** on the existing Redis
- `POST /api/projects/:projectId/deployments` **queues a job** and returns immediately
- A **worker** that processes jobs **2 at a time**, moving each deployment through its statuses and writing logs
- **Retries** with exponential backoff (3 attempts), then a clean `FAILED`
- **Duplicate protection** (job ID = deployment ID) and **graceful shutdown**
- **End-to-end tests** covering the API, the queue, the worker and PostgreSQL

**Phase 4 (Docker-based deployment)**

- The worker **clones the public GitHub repository**, checks out the **exact commit** and **validates the Dockerfile**
- **`docker build`** into `deployx/<project>-<id>:<commit>`, with limited, meaningful build logs
- **`docker run`** as an unprivileged, resource-limited container on the isolated **`deployx-apps`** network, on the project's declared **`container_port`**
- Container tracking (`container_id`, `container_name`, `host_port`), replacement of the previous container, per-deployment workspaces that are always cleaned up
- Build and startup failures end as `FAILED` with the reason; transient failures use the Phase 3 retries
- Test apps in [`examples/`](examples) and opt-in **Docker end-to-end tests**

**Phase 5 (state machine, history, real-time logs)**

- A **deployment state machine** enforced by PostgreSQL: allowed transitions live in one table, a trigger rejects the rest, and the API and worker both change status only through `transitionDeploymentStatus()`
- **Real-time events**: every log line and status change is published to Redis Pub/Sub on a per-deployment channel
- **`GET /api/deployments/:id/logs/stream`** (Server-Sent Events): stored logs first, then live lines and status, resume via `Last-Event-ID`, closes when the deployment finishes
- **Dashboard**: applications → deployment history (newest first) → deployment details with **live logs**, lifecycle steps and errors

**Phase 6 (health checks and automatic rollback)**

- An **HTTP health check** after every `docker run`: configurable path (per project), timeout, interval, retries and startup grace period
- `HEALTH_CHECK` is now part of every deployment; **`SUCCESS` is only reachable from it**, enforced by the database
- **Stable deployments** tracked per project without a flag: the last stable deployment is the newest successful one
- **Automatic rollback** of an unhealthy deployment: the previous version keeps running during the check, is verified (or restarted from its image) and health-checked before anything is called recovered
- Rollback outcome on the deployment (`COMPLETED`, `FAILED`, `NOT_AVAILABLE`), streamed live and shown in the dashboard; a rollback that fails ends the deployment as **`ROLLBACK_FAILED`**
- **Health-check details** (attempts, last status code, response time, error) recorded on the deployment and pushed to the dashboard after every attempt
- See [Phase 6 — Health Checks & Automatic Rollback](#phase-6--health-checks--automatic-rollback)

## Architecture

```text
                ┌──────────────────────────┐
  Browser ────▶ │  client  (React + Vite)  │  :3000
                └────────────┬─────────────┘
                             │  /api/*  (dev proxy)
                             ▼
                ┌──────────────────────────┐
                │  server  (Express API)   │  :5000
                │  routes → controllers →  │
                │  services → db / queues  │
                └──────┬────────────┬──────┘
                       │            │ add job (BullMQ)
                  SQL  │            ▼
                       │       ┌──────────┐
                       │       │  Redis   │  :6379   "deployments" queue
                       │       └────┬─────┘
                       │            │ next job (BullMQ, concurrency 2)
                       │            ▼
                       │  ┌──────────────────────────┐   git clone   ┌────────────┐
                       │  │  worker  (Node.js)       │◀──────────────│   GitHub   │
                       │  └──────┬─────────────┬─────┘               └────────────┘
                       ▼         │ status+logs │ docker build / run (Docker socket), then HTTP health check
             ┌──────────────┐    │             ▼
             │  PostgreSQL  │◀───┘   ┌────────────────────────────────────────┐
             │    :5432     │        │  Docker daemon                         │
             └──────▲───────┘        │   network "deployx-apps" (isolated)    │
                    │                │    └── app containers  127.0.0.1:<port>│
             ┌──────┴───────┐        └────────────────────────────────────────┘
             │   migrate    │  (one-shot job: applies migrations, then exits)
             └──────────────┘
```

The browser only talks to the client. The Vite dev server forwards `/api/*` requests to the API, so the frontend never contains a hard-coded backend URL. Running deployments are followed over **Server-Sent Events** (`/api/deployments/:id/logs/stream`); the API learns about new log lines and status changes from **Redis Pub/Sub** events that the worker publishes (see [Real-Time Deployment Logs](#real-time-deployment-logs-phase-5)).

Once a container runs, the worker requests the project's health-check path on the container's published port. A healthy answer makes the deployment `SUCCESS` and retires the previous container; an unhealthy one triggers a rollback to the last stable deployment (see [Phase 6](#phase-6--health-checks--automatic-rollback)).

Each API request passes through these layers:

| Layer | Folder | Responsibility |
| ----- | ------ | -------------- |
| Routes | `routes/` | URL + HTTP method → middleware chain |
| Validation | `middleware/validation.js`, `validators/` | reject bad IDs and bodies before any SQL runs |
| Controllers | `controllers/` | translate HTTP ⇄ service calls, pick the status code |
| Services | `services/` | business rules and parameterized SQL |
| DB | `db/` | connection pool, Redis client, migrations |
| Queues | `queues/` | BullMQ producer for deployment jobs |

## Tech Stack

| Layer          | Technology                                   |
| -------------- | -------------------------------------------- |
| Frontend       | React 19, Vite 8                             |
| Backend        | Node.js (≥ 20.12), Express 5                 |
| Validation     | zod 4                                        |
| Database       | PostgreSQL 17 (`pg` driver)                  |
| Migrations     | node-pg-migrate 9 (plain SQL files)          |
| Cache / queue  | Redis 7, BullMQ 6, `ioredis` 5               |
| Tests          | Node.js built-in test runner (`node:test`)   |
| Worker         | Node.js, BullMQ 6, `ioredis`, `pg`, `git`, Docker CLI (BuildKit) |
| Local infra    | Docker, Docker Compose                       |

## Database

### Relationships

```text
users
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

Every foreign key cascades. **Deleting a project deletes all of its deployments and their logs in the same statement**, so no orphan rows can remain. A deployment or its logs have no meaning without their project. Deleting a user removes that user's projects in the same way.

### Tables

**`users`**

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `name` | `varchar(100)` | not blank |
| `email` | `varchar(255)` | **unique**, stored lower-case |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` maintained by a trigger |

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
| `docker_image` | `varchar(255)` | image built for this deployment, e.g. `deployx/my-api-0f8fad5b:abc123def456` |
| `docker_image_id` | `varchar(80)` | immutable ID (`sha256:…`) of that image; what a rollback starts again. Internal, not returned by the API |
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

There is no "stable" column. The API's `is_stable` field is derived by `stable_deployment_id(project_id)`: a project's most recently finished `SUCCESS` deployment (see [Stable deployments](#stable-deployments)).

### Indexes

| Index | Serves |
| ----- | ------ |
| `users_email_key` (unique) | look up a user by email |
| `projects_user_id_name_key` (unique `user_id, name`) | "projects of this user", and per-user unique names |
| `deployments_project_id_created_at_idx` (`project_id, created_at DESC`) | "deployments of a project, newest first" |
| `deployment_logs_deployment_id_id_idx` (`deployment_id, id`) | "logs of a deployment in order" |
| `deployments_stable_idx` (`project_id, finished_at DESC`, only `SUCCESS` rows) | "the last stable deployment of a project" |

No separate index is needed on `projects.user_id`, because the unique `(user_id, name)` index already covers lookups that start with `user_id`.

### Migrations

Migrations are plain SQL files in [`server/src/db/migrations`](server/src/db/migrations), each with an `-- Up Migration` and a `-- Down Migration` section. [node-pg-migrate](https://github.com/salsita/node-pg-migrate) records applied files in the `pgmigrations` table and takes an advisory lock, so two processes cannot migrate at the same time.

```bash
# From server/ (uses DATABASE_URL from the root .env)
npm run migrate                         # apply all pending migrations
npm run migrate:down                    # revert the most recent migration
npm run migrate:create -- add-something # new empty SQL migration file

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

`docker compose up` runs the `migrate` service automatically, and the API starts only after it has finished successfully.

## Deployment Jobs (BullMQ)

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
 │        QUEUED → BUILDING → DEPLOYING → SUCCESS      (Docker pipeline, see Phase 4)
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

`deploymentProcessor.js` ([source](worker/src/processors/deploymentProcessor.js)) is a generic runner. It loads the deployment and its project, skips duplicates, logs `Deployment job started (attempt n of m)` and records failed attempts. It hands the actual work to a **pipeline**: in production, [`dockerDeployment.js`](worker/src/pipeline/dockerDeployment.js), described in [Docker Deployments](#docker-deployments-phase-4) along with a full log trace. Phase 3's simulated stages are gone.

### Retries

| Setting | Value | Configured by |
| ------- | ----- | ------------- |
| Attempts | 3 (first run included) | `DEPLOYMENT_JOB_ATTEMPTS` (API) |
| Backoff | exponential: 2 s, then 4 s | `DEPLOYMENT_JOB_BACKOFF_MS` (API) |

When an attempt fails:

1. The worker logs `ERROR Attempt n of 3 failed: <reason>`.
2. If attempts remain, the deployment goes back to **`QUEUED`** and gets `WARN Retrying in 2s (attempt 2 of 3)`. `started_at` keeps the time of the first attempt. BullMQ re-runs the job after the backoff.
3. After the last attempt, the deployment becomes **`FAILED`** (with `finished_at`) and gets `ERROR Deployment failed after maximum retry attempts`. The BullMQ job ends in its `failed` state.

Some errors can't be fixed by trying again, so they fail right away without retries: a missing repository, branch, commit or Dockerfile, a deployment deleted while its job ran, or an unknown job name. The [Phase 4 failure table](#failure-handling-and-retries) lists which failures are retried.

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
- Distributed locking beyond BullMQ's own job locks is out of scope for this phase. A manual `PATCH …/status` while a job is running is not coordinated with that job.

### Redis connections

- **API:** a single ioredis connection ([`server/src/db/redis.js`](server/src/db/redis.js)), used by both `/api/system/status` and the BullMQ queue. Commands fail fast while disconnected.
- **Worker:** one ioredis connection ([`worker/src/config/redis.js`](worker/src/config/redis.js)), which BullMQ duplicates once for its blocking "wait for next job" call.
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

## Docker Deployments (Phase 4)

### Architecture

```text
GitHub (public repository)
   │
   │                         POST /api/projects/:projectId/deployments
   ▼                                          │
DeployX API ──────────────────────────────────┘  creates the record, queues the job
   │
   ▼
PostgreSQL  (deployments, deployment_logs)
   │
   ▼
BullMQ / Redis  ("deployments" queue)
   │
   ▼
Deployment Worker ── <WORKSPACE_ROOT>/<deployment-id>/source   (per-deployment workspace)
   │
   ├── Git Clone     git clone --single-branch --filter=blob:none ; checkout <commit>
   │
   ├── Docker Build  docker build -f <dockerfile_path> -t deployx/<slug>-<id8>:<sha12> <repo root>
   │
   └── Docker Run    docker run --network deployx-apps -p 127.0.0.1::<container_port> …
          │
          ▼
     Application  (container on the isolated "deployx-apps" network)
```

The **API** still only creates the deployment and queues the job. It has no Docker access. The **worker** does all the work. Deployed apps run as ordinary containers on the host's Docker. They are not part of `docker-compose.yml`.

### Deployment lifecycle

```text
QUEUED ──▶ BUILDING ──────────────────────────────────▶ DEPLOYING ────────────────────▶ HEALTH_CHECK ──────────────▶ SUCCESS
            clone → checkout commit → check Dockerfile     docker run → still running      GET <health_check_path>,      previous container
            → docker build → image tagged                   after CONTAINER_STARTUP_        with retries                  removed
                                                            GRACE_MS
   any failure in BUILDING or DEPLOYING ──▶ QUEUED (retry, if attempts remain) or FAILED
   unhealthy in HEALTH_CHECK ──▶ ROLLING_BACK ──▶ FAILED or ROLLBACK_FAILED   (see Phase 6)
```

The worker updates PostgreSQL at every stage. Each status change is written **in the same SQL statement as its log line**, so the API never shows a status without its log line. A successful deployment's logs look like this (real output, trimmed):

```text
INFO  Deployment created                                          ← API
INFO  Deployment job started (attempt 1 of 3)                     ← worker
INFO  Deployment is now building                                    status BUILDING
INFO  Cloning repository https://github.com/devtejasx/DeployX (branch main)
INFO  Checking out commit d577dab0332ab12f17d535b8ea17f9c3840fa818
INFO  Dockerfile found at examples/hello-app/Dockerfile
INFO  Starting Docker build of deployx/hello-app-be9b5c8c:d577dab0332a
INFO  #5 [1/3] FROM docker.io/library/node:22-alpine@sha256:…     ← selected build output
INFO  #6 [2/3] WORKDIR /app
INFO  #7 [3/3] COPY examples/hello-app/server.js ./server.js
INFO  #8 naming to docker.io/deployx/hello-app-be9b5c8c:d577dab0332a done
INFO  Docker image created: deployx/hello-app-be9b5c8c:d577dab0332a
INFO  Deployment is now deploying                                   status DEPLOYING
INFO  Starting container deployx-be9b5c8c-…-f0ce4c66-…
INFO  Container started: deployx-be9b5c8c-…-f0ce4c66-… (46efbbd75580); port 3000 published on 127.0.0.1:10124
INFO  Cleanup completed: workspace removed
INFO  Running health checks: GET http://127.0.0.1:10124/health (up to 5 attempts, 2s timeout, 2s apart)   status HEALTH_CHECK
INFO  Waiting 5s for the application to start
INFO  Health check attempt 1/5 passed: HTTP 200 in 44ms
INFO  Deployment completed successfully                             status SUCCESS
```

`GET /api/deployments/:deploymentId` then shows what was deployed:

```json
{
  "status": "SUCCESS",
  "commit_sha": "d577dab0332ab12f17d535b8ea17f9c3840fa818",
  "docker_image": "deployx/hello-app-be9b5c8c:d577dab0332a",
  "container_id": "46efbbd75580…",
  "container_name": "deployx-be9b5c8c-9e91-474e-8b66-9faff1dbe500-f0ce4c66-eebc-4fe1-babd-7d4c50f2ee3d",
  "host_port": 10124,
  "container_removed_at": null,
  "error_message": null,
  "started_at": "2026-09-28T09:27:18.589Z",
  "finished_at": "2026-09-28T09:27:27.862Z"
}
```

`curl http://127.0.0.1:10124/` then returns `Hello from DeployX`. Since Phase 6 the deployment only reaches `SUCCESS` through `HEALTH_CHECK` (see [Phase 6](#phase-6--health-checks--automatic-rollback)).

### Git clone and commit checkout

[`gitService.js`](worker/src/services/gitService.js) runs, without a shell:

```text
git clone --single-branch --branch <branch> --filter=blob:none --no-checkout -- <github_repo> <workspace>/source
git rev-parse --verify <commit_sha>^{commit}    # resolves abbreviated SHAs; must exist on that branch
git checkout --detach <full sha>
git rev-parse HEAD                              # verified to equal the resolved SHA
```

- **Exact commit, not "whatever the branch points at now".** If the deployment has a `commit_sha`, exactly that commit is built. A commit that isn't on the branch fails the deployment (`Commit … not found on branch main`). Without a `commit_sha`, the branch head is built and **its full SHA is written back to `commit_sha`**, so every deployment records exactly what it ran.
- **Public GitHub repositories only.** The worker re-checks the `https://github.com/<owner>/<repo>` format. Git prompts are disabled, and the machine's git config and credential helpers are ignored (`GIT_CONFIG_NOSYSTEM`, a throwaway `GIT_CONFIG_GLOBAL`, `credential.helper=`). A private or missing repository therefore fails with a clear message instead of hanging or using your stored GitHub token. Private repositories come in Phase 7.
- Only the `https` transport is allowed (`protocol.allow=never`), and symlinks are checked out as plain files (`core.symlinks=false`).

### Dockerfile validation

The configured `dockerfile_path` must resolve **inside** the checked-out repository, and it must be a **regular file**. Symlinks and paths with `..` are refused. If it's missing, the deployment fails with `Dockerfile not found at <path>` and no build is started.

### Docker build and image naming

```text
docker build --progress=plain --file <workspace>/source/<dockerfile_path> --tag <image> \
             --label deployx.managed=true --label deployx.project=<id> --label deployx.deployment=<id> \
             -- <workspace>/source
```

- The **build context is the repository root**. A `<Dockerfile>.dockerignore` next to the Dockerfile (BuildKit) can shrink it. The [examples](examples) use one.
- **Image name:** `deployx/<project-slug>-<first 8 chars of project id>:<first 12 chars of commit SHA>`, for example `deployx/hello-app-be9b5c8c:d577dab0332a`.
  - The slug is the project name, lower-cased, with anything other than `a-z0-9` replaced by `-` and cut to 40 characters.
  - The project-ID suffix keeps apart two projects whose names produce the same slug (`My API` and `my-api`).
  - The tag is always the commit, never `latest`.
  - Since Phase 6 every image gets a **second tag**, `…:deployment-<deployment-id>`. Building the same commit again moves the commit tag to the new image; the deployment tag keeps each deployment's own image on the Docker host, so a rollback can start it again.
- **Build logs are limited** ([`buildLog.js`](worker/src/lib/buildLog.js)):
  - Only build steps (`#7 [2/4] RUN …`), errors and the final "naming to" line are stored, each once.
  - Each line is capped at 1000 characters, and each attempt at 150 lines (`BUILD_LOG_MAX_LINES`). A warning says how many lines were dropped.
  - Credentials in URLs are masked.
  - **On failure, the last lines of output are always stored**, so the error is visible even after the cap. Full live output is Phase 5.
- Builds time out after `DOCKER_BUILD_TIMEOUT_MS` (10 min).

### Container naming, ports and networking

- **Container name:** `deployx-<project-id>-<deployment-id>`. It's unique per deployment, and the container is labelled with both IDs.
- **Port:** each project has a required **`container_port`**, the port the app listens on *inside* its container. DeployX never guesses it. Set it when creating the project (`"container_port": 3000`), or change it with `PUT /api/projects/:id`. Docker publishes it on **127.0.0.1** at a random free host port, stored as `host_port`.
- **Network:** apps join **`deployx-apps`**, a separate bridge network that the worker creates on first use:
  - DeployX's own services (PostgreSQL, Redis, API, worker) are **not** on it, so their names don't resolve and they can't be reached through Docker's internal network.
  - **Inter-container traffic is disabled** (`enable_icc=false`), so deployed apps can't talk to each other either.
  - Apps can reach the internet.
- **Environment:** apps get **no** DeployX environment variables: no `DATABASE_URL`, `REDIS_URL`, passwords, Docker or GitHub credentials. They only get what their own image defines. Per-project environment variables are a later feature.

### One active deployment per project

When a new deployment has **passed its health check and is `SUCCESS`**, the worker removes the project's **other** DeployX containers, found by the `deployx.project` label. Until then the previous version keeps running, so a deployment that fails to start, or starts but is unhealthy, never takes the running version down. Containers of deployments that another job is still processing are left to that job. Replaced deployments stay in the history:
- their row and logs remain;
- `container_removed_at` is set;
- a log line says `Container removed: replaced by deployment <id>`.

If two deployments of the same project finish at nearly the same moment, the one that finishes last wins: promotions of one project run one at a time (see [Concurrent deployments](#concurrent-deployments)).

### Failure handling and retries

| Failure | Status path | Retried? | `error_message` |
| ------- | ----------- | -------- | --------------- |
| Repository or branch missing / private | `BUILDING → FAILED` | no | `Repository … not found or not public` / `Branch "x" not found in …` |
| Commit not on the branch | `BUILDING → FAILED` | no | `Commit … not found on branch main` |
| Dockerfile missing | `BUILDING → FAILED` | no | `Dockerfile not found at <path>` |
| Project has no `container_port` | `FAILED` | no | `Project has no container_port configured; …` |
| Network error while cloning | `BUILDING → QUEUED → …` | yes (3 attempts) | last error |
| `docker build` fails | `BUILDING → QUEUED → … → FAILED` | yes (3 attempts) | `Docker build failed: <error line>` |
| Container exits right away | `DEPLOYING → QUEUED → … → FAILED` | yes (3 attempts) | `Container exited immediately (exit code n)` |
| Container runs but is unhealthy | `HEALTH_CHECK → ROLLING_BACK → FAILED` (or `→ ROLLBACK_FAILED` if the rollback fails), or `HEALTH_CHECK → FAILED` without a stable deployment | no (the health check has its own retries) | `Health check failed after n attempts: … Rolled back to deployment <id>.` ([all cases](#failure-scenarios)) |

- Retries use the **existing BullMQ policy** from Phase 3: 3 attempts with 2 s and then 4 s backoff. There is no second retry mechanism. All attempts belong to the **same deployment record**; the logs show `Deployment job started (attempt 2 of 3)`.
- Failures that another attempt can't fix are raised as BullMQ `UnrecoverableError` and fail at once (`Deployment failed and will not be retried`). Build failures are retried, because many are transient (a registry timeout, `npm install` hitting the network).
- A container that exits is **removed**, and its last 30 output lines are stored as `[container] …` log lines. After the startup grace period the container must still be running; then the health check decides whether the deployment is `SUCCESS`.

### Workspace cleanup

- Each attempt starts from an **empty** `<WORKSPACE_ROOT>/<deployment-id>/` directory. The directory name is the deployment UUID and is checked, so it can't escape the workspace root.
- The workspace is removed at the end of every attempt, successful or not (`Cleanup completed: workspace removed`). If removal fails, a `WARN` log says so. It never changes the deployment's result.
- If a worker is killed mid-job, the next worker start removes workspaces older than an hour.
- **Images:** successful images are kept, because a rollback may have to start one again. A failed BuildKit build doesn't tag an image, so nothing half-built is left behind. Images of containers that failed to start are kept, and the container itself is removed. DeployX never prunes images in bulk.

### Security measures and limitations (development setup)

Repository code and Dockerfiles are treated as **untrusted**. What this implementation does:

| Measure | Where |
| ------- | ----- |
| No shell anywhere: `git`/`docker` run via `spawn` with argument arrays; values are passed after `--` | [`exec.js`](worker/src/lib/exec.js) |
| Child processes get an env **allowlist** (PATH, HOME, DOCKER_HOST …). `DATABASE_URL`, `REDIS_URL` and other secrets are never passed to `git`/`docker` | [`exec.js`](worker/src/lib/exec.js) |
| Repo URL, branch, SHA and Dockerfile path are re-validated in the worker; paths can't leave the workspace; Dockerfile symlinks are refused | [`gitService.js`](worker/src/services/gitService.js), [`workspace.js`](worker/src/services/workspace.js) |
| Apps are **not privileged**: `--cap-drop ALL` + 8 common capabilities, `no-new-privileges`, 512 MB memory, 1 CPU, 256 processes, no volumes or bind mounts, no Docker socket, no DeployX env vars | [`dockerService.js`](worker/src/services/dockerService.js) |
| Apps run on their own network with inter-container traffic off; app ports are bound to 127.0.0.1 | [`dockerService.js`](worker/src/services/dockerService.js) |
| PostgreSQL, Redis, API and dashboard ports are published on 127.0.0.1 only; **Redis requires a password** | [`docker-compose.yml`](docker-compose.yml) |

**Known limitations. Don't run untrusted code with this setup on a machine you care about.** Production isolation is Phase 8.

1. **The worker controls the host's Docker daemon.** In Docker Compose, `/var/run/docker.sock` is mounted into the **worker** (only the worker), and that's root-equivalent on the Docker host. It's needed to run `docker build`/`docker run`.
   - A filtering socket proxy (`tecnativa/docker-socket-proxy`) was tried. It blocks BuildKit's gRPC session, so builds fail.
   - Phase 8 options: a rootless Docker/BuildKit daemon, a separate build host, or a sandboxed runtime such as gVisor or Kata.
2. **Builds run with the daemon's normal privileges.** `RUN` steps can use the network. Resource limits apply to the running app, not to the build, which is bounded only by its timeout.
3. **Docker Desktop's host IP.** On Docker Desktop, containers can reach the host's published ports through `host.docker.internal` / `192.168.65.254`, even when those ports are bound to 127.0.0.1. On plain Linux Docker, 127.0.0.1-bound ports are not reachable from containers.
   - So on Docker Desktop, a deployed app can reach PostgreSQL (password-protected), Redis (password-protected) and **the API, which has no authentication yet**.
   - Change the default passwords in `.env` if others can deploy on your machine. Authentication is Phase 8.
4. **The API can't stop containers.** Deleting a project removes its database rows, but not its running container, because the API deliberately has no Docker access. Remove leftovers with:
   ```bash
   docker rm -f $(docker ps -aq --filter label=deployx.managed=true)
   ```
5. Only public GitHub repositories. No build secrets and no per-project environment variables yet.

### Local setup and the test repository

- **Test repository:** this repository itself. [`examples/`](examples) holds the test apps:
  - `hello-app` answers `GET /` with `Hello from DeployX` and `GET /health` with `200`, on port 3000
  - `unhealthy-app` keeps running but answers `GET /health` with `503` (health-check failure and rollback)
  - `crash-app` exits immediately after starting
  - `broken-dockerfile` has an invalid instruction
- To use a repository of your own, it needs a Dockerfile and an app listening on a known port that answers a health-check request with a 2xx status. Set `container_port` to that port and, if the endpoint is not `/health`, `health_check_path` to its path.

```bash
docker compose up -d --build          # full stack, worker included (needs Docker Desktop / Docker Engine)

curl -s -X POST localhost:5000/api/projects -H "Content-Type: application/json" -d '{
  "name": "hello-app",
  "github_repo": "https://github.com/devtejasx/DeployX",
  "dockerfile_path": "examples/hello-app/Dockerfile",
  "container_port": 3000
}'
curl -s -X POST localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'
curl -s localhost:5000/api/deployments/<deploymentId>         # status, image, container, host_port
curl -s localhost:5000/api/deployments/<deploymentId>/logs    # clone, build and run logs
curl -s http://127.0.0.1:<host_port>/                         # Hello from DeployX
```

Running the worker outside Docker (`npm run dev:worker`) works the same way, using your local `git` and `docker` CLIs. On Linux, give Compose the socket's group: `DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)` in `.env`.

## Deployment State Machine (Phase 5)

> **Phase 6 extended this machine** with `HEALTH_CHECK`, `ROLLING_BACK` and the final status `ROLLBACK_FAILED`, and removed `DEPLOYING → SUCCESS`. The current map is in [Phase 6 → State machine](#state-machine). This section describes how the machine is built and enforced, which has not changed.

As introduced in Phase 5, a deployment could only move between statuses along these edges:

```text
             ┌────────────── retry (BullMQ backoff) ─────────────┐
             ▼                                                    │
         ┌────────┐      ┌──────────┐      ┌───────────┐      ┌─────────┐
  new ──▶│ QUEUED │─────▶│ BUILDING │─────▶│ DEPLOYING │─────▶│ SUCCESS │  final
         └───┬────┘      └────┬─────┘      └─────┬─────┘      └─────────┘
             │                │                  │
             └────────────────┴──────────────────┴──────────▶  FAILED     final
```

| From | Allowed to | Why |
| ---- | ---------- | --- |
| `QUEUED` | `BUILDING`, `FAILED` | the worker starts the job / it could not be queued or failed before building |
| `BUILDING` | `DEPLOYING`, `FAILED`, `QUEUED` | image built / failed for good / attempt failed, BullMQ will retry |
| `DEPLOYING` | `SUCCESS`, `FAILED`, `QUEUED` | container running / failed for good / attempt failed, BullMQ will retry |
| `SUCCESS`, `FAILED` | nothing | final |
| (`HEALTH_CHECK`) | reserved in Phase 5; in use since Phase 6 | see [Phase 6 → State machine](#state-machine) |

`BUILDING/DEPLOYING → QUEUED` is kept on purpose. Since Phase 3, a failed attempt waits in `QUEUED` until BullMQ retries it; every attempt stays on the same deployment row. Everything else is rejected, for example `SUCCESS → BUILDING`, `FAILED → DEPLOYING` and `SUCCESS → QUEUED`.

**Where it's enforced.** The API and the worker are separate packages. The only place both can share one definition is the **database**. Migration [`1790671094193_deployment-state-machine`](server/src/db/migrations/1790671094193_deployment-state-machine.sql) adds three things:

- **`deployment_status_transitions`**: the map above, as rows with descriptions. Phase 6 extended it with migrations that insert and delete rows; no code changed to enforce the new edges.
- a **trigger** on `deployments` that rejects any status change not in the table, with SQLSTATE `DX001` and detail `{"from","to"}`. It applies to every writer: the API, the worker, or plain SQL.
- **`transition_deployment_status(id, status, error_message)`**, the one function that changes status:
  1. It locks the row and reads the current status.
  2. It returns nothing for an unknown deployment.
  3. It's a **no-op** if the status is already the target, so repeating a step is harmless.
  4. Otherwise it applies the change and keeps the timestamps right: `started_at` when work first begins (kept across retries), `finished_at` on `SUCCESS`/`FAILED`, and `error_message` on `FAILED`.

In code, both sides call a `transitionDeploymentStatus(deploymentId, newStatus)` wrapper. No code writes `deployments.status` directly.

- **API:** [`deploymentStateMachine.js`](server/src/services/deploymentStateMachine.js). `PATCH /api/deployments/:id/status` returns **409** for an invalid transition:
  ```json
  { "success": false, "error": { "message": "Invalid deployment state transition", "from": "SUCCESS", "to": "BUILDING" } }
  ```
- **Worker:** `transitionDeploymentStatus()` in [`deploymentService.js`](worker/src/services/deploymentService.js). It still writes the status and its log line in one statement. An invalid transition ends the job as an `UnrecoverableError`, without retries; for example, when someone sets a running deployment to `FAILED` by hand.

## Real-Time Deployment Logs (Phase 5)

```text
Worker / API
   │  1. INSERT deployment_logs / transition_deployment_status()   (PostgreSQL: source of truth)
   │  2. PUBLISH <QUEUE_PREFIX>:deployment:<id>:events               (Redis Pub/Sub: "something changed")
   ▼
Redis ──▶ API subscriber (one connection, one channel per watched deployment)
               │ 3. re-read PostgreSQL: lines after the last one sent, current status
               ▼
          GET /api/deployments/:id/logs/stream   (Server-Sent Events)
               │
               ▼
          React: EventSource → log viewer + status
```

**Events.** Every persisted log line and status change is published on the deployment's **own** channel, `<QUEUE_PREFIX>:deployment:<deploymentId>:events`. So events of deployment A can never reach a stream of deployment B. The payloads are `{type:"log", log:{id, level, message, created_at}}` and `{type:"status", status}`.
- The worker publishes on its existing Redis connection; the API on its single shared one.
- Publishing is **best effort**: the row is already committed. A Redis outage is logged, never turned into a failed request or job.

**The stream.** `GET /api/deployments/:deploymentId/logs/stream` responds with `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`:

```text
retry: 3000

id: 1041
event: log
data: {"id":"1041","deployment_id":"…","level":"INFO","message":"Cloning repository …","created_at":"…"}

event: status
data: { …the deployment, exactly as GET /api/deployments/:id… }

: keep-alive

event: end
data: {"deploymentId":"…","status":"SUCCESS"}
```

1. The deployment is checked first, so an unknown or foreign ID gets the normal JSON `404`/`400`, not a stream.
2. **Stored lines are sent first** (all of them, or those after `Last-Event-ID`), then the current status.
3. Each Redis event, plus a database check every `LOG_STREAM_POLL_MS` (2 s) as a safety net, makes the stream **re-read PostgreSQL** for lines after the last one it sent. Events aren't forwarded blindly. So lines always arrive **in database order, without gaps or duplicates**, even when an event is lost or Redis is down (then updates arrive within the poll interval instead of instantly).
4. A `status` event carries the whole deployment and is sent **whenever the record changed**: its status, but also its health-check progress, image or container. The stream sends `end` and **closes** once the deployment is final: `SUCCESS`, `FAILED` or `ROLLBACK_FAILED`. `HEALTH_CHECK` and `ROLLING_BACK` are not final, so health-check attempts and the whole rollback are streamed before the stream ends. Keep-alive comments go out every 15 s.
5. When the client disconnects, the timers and the Redis listener are released. The API holds **one** subscriber connection for all streams, and each deployment channel is subscribed once, however many browsers watch it. When the last stream leaves, the channel is unsubscribed.
6. If the database fails mid-stream, the API sends `stream-error` and closes, and the browser reconnects. On shutdown the API ends open streams so browsers reconnect elsewhere.

**Reconnects.** Every log event carries its database id as the SSE `id`.
- The browser's `EventSource` reconnects by itself, sending `Last-Event-ID`, and receives only the lines it missed.
- If the browser gives up (for example, the dev proxy answered `502` while the API restarted), the dashboard reopens the stream itself with `?lastEventId=<id>`, after checking that the deployment still exists.
- The UI also ignores any line id it has already shown. Verified by restarting the API in the middle of a deployment: the page ended with all 56 lines, 0 duplicates.

**Worker crashes.** If the worker dies mid-job, the stream stays open (keep-alives) and shows the last known status. When BullMQ hands the stalled job to a worker again, new lines and statuses flow as usual. Since Phase 6 that job finds the deployment still in `BUILDING`, `DEPLOYING` or `HEALTH_CHECK`, logs `Previous attempt was interrupted during <status>; starting again`, puts it back to `QUEUED` and runs the attempt from the beginning.

## Phase 6 — Health Checks & Automatic Rollback

A deployment is no longer successful because its container started. After `docker run`, the worker checks the application over HTTP. Only a healthy answer leads to `SUCCESS`; an unhealthy deployment is rolled back to the project's last stable deployment.

```text
Deployment
    ↓
Docker  (build, run)
    ↓
Health Check
    ↓
Healthy?
  ┌───┴────┐
 YES       NO
  ↓         ↓
SUCCESS   ROLLBACK
(stable)    ↓
        Last Stable Version  ── none ──▶ FAILED  (nothing to roll back to)
            ↓
        Health Check
         ┌───┴────┐
        YES       NO
         ↓         ↓
     RECOVERED   ROLLBACK_FAILED
     (the new deployment is FAILED,
      the stable version is live)
```

### State machine

```text
             ┌───────────────────────── retry (BullMQ backoff) ────────────────────────┐
             ▼                                                                          │
         ┌────────┐     ┌──────────┐     ┌───────────┐     ┌──────────────┐     ┌─────────┐
  new ──▶│ QUEUED │────▶│ BUILDING │────▶│ DEPLOYING │────▶│ HEALTH_CHECK │────▶│ SUCCESS │  final
         └───┬────┘     └────┬─────┘     └─────┬─────┘     └───┬──────┬───┘     └─────────┘
             │               │                 │               │      │ unhealthy, a stable deployment exists
             │               │                 │               │      ▼
             │               │                 │               │  ┌──────────────┐  stable version not restored
             │               │                 │               │  │ ROLLING_BACK │────────────────────────────▶  ROLLBACK_FAILED  final
             │               │                 │               │  └──────┬───────┘
             │               │                 │               │         │ stable version restored and healthy
             └───────────────┴─────────────────┴───────────────┴─────────┴──────▶  FAILED     final
                                                     unhealthy, nothing to roll back to
```

| From | Allowed to | Why |
| ---- | ---------- | --- |
| `QUEUED` | `BUILDING`, `FAILED` | unchanged |
| `BUILDING` | `DEPLOYING`, `FAILED`, `QUEUED` | unchanged |
| `DEPLOYING` | `HEALTH_CHECK`, `FAILED`, `QUEUED` | container running / failed for good / attempt failed, BullMQ will retry. **`DEPLOYING → SUCCESS` no longer exists** |
| `HEALTH_CHECK` | `SUCCESS`, `ROLLING_BACK`, `FAILED`, `QUEUED` | healthy / unhealthy with a stable deployment / unhealthy without one / an unexpected error, BullMQ will retry |
| `ROLLING_BACK` | `FAILED`, `ROLLBACK_FAILED` | the stable version is live again; the deployment itself failed / the stable version could not be brought back |
| `SUCCESS`, `FAILED`, `ROLLBACK_FAILED` | nothing | final |

Three decisions are worth knowing:

- **`SUCCESS` is only reachable from `HEALTH_CHECK`.** Migration [`1790767291227`](server/src/db/migrations/1790767291227_health-check-required-and-image-id.sql) deletes the `DEPLOYING → SUCCESS` row, so "never successful before the health check" is a database rule for the worker, the API and plain SQL alike.
- **`FAILED` stays final, so the rollback happens before it: `HEALTH_CHECK → ROLLING_BACK → FAILED`**, not `FAILED → ROLLING_BACK`. The live log stream ends on a final status. If a deployment became `FAILED` first, the dashboard would stop following it before the rollback started. `SUCCESS → ROLLING_BACK`, `BUILDING → ROLLING_BACK`, `FAILED → ROLLING_BACK` and `ROLLING_BACK → SUCCESS` are all rejected. A rolled-back deployment never becomes `SUCCESS`; the outcome of its rollback is stored next to it (see [Rollback](#rollback)).
- **Two ways to fail after a health check.** `FAILED` means this deployment failed and the project is in a known state: the stable version is live, or there never was one. `ROLLBACK_FAILED` means the rollback itself failed: the stable version could not be restored or is unhealthy too, so **no healthy version is live** and someone has to look. It is a final status of its own rather than a flag on `FAILED`, so it stands out in the history and the API.

### Health-check configuration

The worker requests `GET http://<host>:<port><path>`:

| Setting | Where | Default | Meaning |
| ------- | ----- | ------- | ------- |
| path | project: `health_check_path` | `/health` | an absolute path, optionally with a query string (`/`, `/healthz`, `/api/status?probe=1`) |
| port | project: `container_port` | required | the app's port in the container; the check goes to the host port Docker published it on (`host_port`) |
| host | worker: `HEALTH_CHECK_HOST` | `127.0.0.1` | where published ports are reachable from the worker. Docker Compose sets `host.docker.internal` |
| timeout | worker: `HEALTH_CHECK_TIMEOUT_MS` | `2000` | time one request may take |
| interval | worker: `HEALTH_CHECK_INTERVAL_MS` | `2000` | pause between two attempts |
| retries | worker: `HEALTH_CHECK_RETRIES` | `5` | attempts before the deployment counts as unhealthy |
| startup grace period | worker: `HEALTH_CHECK_STARTUP_GRACE_MS` | `5000` | time the app gets to start before the first attempt |

```bash
# An app whose health endpoint is not /health
curl -X PUT localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" \
  -d '{ "health_check_path": "/api/status" }'
```

Nothing is hard-coded in the pipeline: the path comes from the project, the rest from the worker's configuration ([`config/index.js`](worker/src/config/index.js)).

### Health-check target

The check goes to **`<HEALTH_CHECK_HOST>:<host_port>`**, the port Docker published for the container, not to `<container name>:<container port>`. That follows from how Phase 4 runs apps:

- Apps run on the `deployx-apps` network with inter-container traffic disabled, and the worker is deliberately not on that network. A container name is therefore neither resolvable nor reachable from the worker.
- Every app's `container_port` is published on `127.0.0.1:<random port>` of the Docker host and recorded as `host_port`. That is the one address through which anything outside the container reaches it, so it is also what a health check should exercise.
- A worker running on the host (`npm run dev:worker`) uses `127.0.0.1`. A worker inside Docker Compose is a container itself, where `127.0.0.1` is the worker; it reaches the host's published ports as `host.docker.internal`, which Compose sets as `HEALTH_CHECK_HOST`.
- When a rollback re-checks a stable container, the port is read from Docker (`docker container inspect`), not from the database: a container that was restarted by hand gets a new host port.

### Health checks and retries

[`healthCheckService.js`](worker/src/services/healthCheckService.js) has two functions:

- **`checkContainerHealth({ host, port, path, timeout })`** sends one request and never throws:
  ```json
  { "healthy": true,  "statusCode": 200, "responseTime": 143 }
  { "healthy": false, "statusCode": 500, "responseTime": 12, "error": "Health check returned HTTP 500" }
  { "healthy": false, "responseTime": 2001, "error": "Health check timed out after 2000ms" }
  ```
  **Healthy means a 2xx answer within the timeout.** Any other status, a redirect (never followed), a timeout, a refused connection or a non-HTTP answer is unhealthy. The response body is not downloaded.
- **`waitForHealthy(...)`** adds the waiting:
  ```text
  wait the startup grace period → attempt 1 → fail → wait the interval → attempt 2 → fail → wait → attempt 3 → healthy
  ```
  One failed request is never final. The first healthy answer ends the check. After the configured number of attempts the deployment is unhealthy. The loop is bounded (at most 50 attempts, whatever the configuration says).

Every attempt is a log line, so it shows up live in the dashboard:

```text
INFO  Running health checks: GET http://127.0.0.1:10124/health (up to 5 attempts, 2s timeout, 2s apart)   status HEALTH_CHECK
INFO  Waiting 5s for the application to start
WARN  Health check attempt 1/5 failed: Health check returned HTTP 503
INFO  Health check attempt 2/5 passed: HTTP 200 in 38ms
INFO  Deployment completed successfully                                                                     status SUCCESS
```

A health-check failure is **not retried by BullMQ**. Rebuilding the same commit can't make it healthy, so the job runs once and the deployment is rolled back. Build and startup failures keep their Phase 3 retries.

**Health-check details.** Besides the log lines, the worker keeps a summary on the deployment (`deployments.health_check`), updated after every attempt and returned by the API:

```json
{
  "status": "FAILED",
  "attempts": 5,
  "max_attempts": 5,
  "status_code": 503,
  "response_time": 3,
  "error": "Health check returned HTTP 503",
  "started_at": "2026-09-30T13:41:46.512Z",
  "completed_at": "2026-09-30T13:41:59.637Z"
}
```

`status` is `RUNNING`, `PASSED` or `FAILED`; `status_code`, `response_time` and `error` describe the last attempt (`status_code` is `null` when there was no HTTP answer, e.g. a timeout). It is one JSON column rather than eight columns, and it is `null` for a deployment that never reached its health check. The log stream sends the deployment whenever this changes, so the dashboard shows "Attempt 3 / 5" while the status is still `HEALTH_CHECK`. A deployment's own record is only about its own check: re-checking a stable deployment during a rollback does not touch that deployment's `health_check`.

### Stable deployments

> A deployment is **stable** when it is `SUCCESS`. The **last stable deployment** of a project is its most recently finished `SUCCESS` deployment.

There is **no `is_stable` column**. Since `SUCCESS` can only follow a passed health check, "successful" already means "was healthy", and a failed or rolled-back deployment is `FAILED`, so it can never be stable. The definition lives in one PostgreSQL function, `stable_deployment_id(project_id)` (with a partial index on successful deployments), used by both sides:

- the **worker** uses it to choose the rollback target, always by project ID, so a project is never rolled back to another project's deployment;
- the **API** reports it as `is_stable` on every deployment (`true` for exactly one deployment per project, or none).

When a new deployment succeeds it becomes the stable one simply by being the newest success. The previous one is no longer current, and nothing about it is rewritten: old deployments are never deleted or modified, only their `container_removed_at` is set when their container is retired.

### Rollback

**The previous version keeps running during the health check.** Phase 4 replaced the old container as soon as the new one started. Now the old container is only retired after the new deployment is `SUCCESS`. So when a new version is unhealthy, the stable version is normally still serving, and the rollback is mostly a verification.

[`rollbackService.js`](worker/src/services/rollbackService.js), called by [`pipeline/release.js`](worker/src/pipeline/release.js):

```text
Health check failed
   ↓
Find the project's last stable deployment ── none ──▶ remove the unhealthy container ──▶ FAILED (rollback NOT_AVAILABLE)
   ↓
ROLLING_BACK
   ↓
Remove the unhealthy container
   ↓
Stable container still running? ── no ──▶ image still there? ── no ──▶ rollback FAILED ──▶ ROLLBACK_FAILED
   │ yes                                    │ yes
   │                                        ▼
   │                                   start the stable image again
   ▼                                        ▼
Health check the stable version ── unhealthy ──▶ rollback FAILED ──▶ ROLLBACK_FAILED
   ↓ healthy
rollback COMPLETED ──▶ the failed deployment becomes FAILED
```

The outcome is stored on the **failed** deployment:

| `rollback_status` | Final `status` | Meaning | `rollback_deployment_id` |
| ----------------- | -------------- | ------- | ------------------------ |
| `COMPLETED` | `FAILED` | the stable deployment is live and passed its health check | the restored deployment |
| `FAILED` | `ROLLBACK_FAILED` | it could not be restored, or it is unhealthy too | the deployment that was tried |
| `NOT_AVAILABLE` | `FAILED` | the project had no stable deployment | `null` |
| `null` | any | no rollback applied (every deployment that did not fail its health check) | `null` |

```json
{
  "status": "FAILED",
  "error_message": "Health check failed after 5 attempts: Health check returned HTTP 503. Rolled back to deployment 6e1c550e-995d-48c4-8feb-4ba8be22f8e6.",
  "health_check": { "status": "FAILED", "attempts": 5, "max_attempts": 5, "status_code": 503, "error": "Health check returned HTTP 503", "…": "…" },
  "rollback_status": "COMPLETED",
  "rollback_deployment_id": "6e1c550e-995d-48c4-8feb-4ba8be22f8e6",
  "is_stable": false
}
```

The logs of a rollback (real output, trimmed). They go through the same PostgreSQL → Redis → SSE pipeline as every other line; nothing new was built for them:

```text
WARN  Health check attempt 5/5 failed: Health check returned HTTP 503
ERROR Health check failed after 5 attempts: Health check returned HTTP 503
INFO  [container] unhealthy-app listening on port 3000 (GET /health returns 503)
ERROR Deployment marked unhealthy
INFO  Starting automatic rollback                                          status ROLLING_BACK
INFO  Previous stable deployment: 6e1c550e-… (commit ad055e3)
INFO  Stopping unhealthy container deployx-c01eaaf9-…-c701a385-…
INFO  Container removed: the deployment failed its health check
INFO  Stable container deployx-c01eaaf9-…-6e1c550e-… is still running
INFO  Running health check on the stable version
INFO  Health check attempt 1/5 passed: HTTP 200 in 13ms
INFO  Stable version is healthy
INFO  Rollback completed successfully: deployment 6e1c550e-… is live
ERROR Deployment failed: the application is unhealthy; the last stable version was restored   status FAILED
```

The restored deployment gets one line too: `Restored as the live version: deployment <id> failed its health check`.

**Restoring from the image.** If the stable container is gone (removed, crashed, Docker restarted), the worker starts the stable deployment again from its image, waits, health-checks it and records the new container on that deployment:

```text
INFO  Starting stable version from image deployx/rollback-demo-c01eaaf9:ad055e343546 (ID 3e0e7bbbd3ba)
INFO  Running health check on the stable version
INFO  Waiting 5s for the application to start
INFO  Health check attempt 1/5 passed: HTTP 200 in 31ms
INFO  Stable version is healthy
```

Two details make this exact:

- Images are tagged `<repository>:<commit>`. Building the same commit again (for example after changing `dockerfile_path`) **moves that tag** to the new image. So the worker records the immutable **image ID** (`deployments.docker_image_id`) and a rollback starts that ID, not the tag.
- Every build also gets a second tag, `<repository>:deployment-<deployment-id>`, which keeps the image on the Docker host after the commit tag moved.

### Failure scenarios

| Situation | Result |
| --------- | ------ |
| Unhealthy, stable deployment still running | `HEALTH_CHECK → ROLLING_BACK → FAILED`, rollback `COMPLETED`; the stable container never stopped |
| Unhealthy, stable container gone, image present | the stable version is started from its image and health-checked; rollback `COMPLETED` |
| **First deployment** of a project is unhealthy | no rollback is attempted: `HEALTH_CHECK → FAILED`, rollback `NOT_AVAILABLE`, error ends with `No previous stable deployment available for rollback.` |
| The stable version is unhealthy too | `ROLLING_BACK → ROLLBACK_FAILED`, rollback `FAILED`: `Rollback failed: the stable deployment is unhealthy too (…)`. Nothing claims a recovery |
| Stable container gone and its image removed | `ROLLBACK_FAILED`: `image … of the stable deployment is no longer available`. Nothing is started |
| The restarted stable container exits at once | `ROLLBACK_FAILED`: `the stable container exited immediately (exit code n)` |
| Health endpoint returns 404 / 500, times out, or the connection is refused | unhealthy like any other failure; same paths as above |
| Application starts slowly | the startup grace period and the retries cover it: early failed attempts are logged as warnings, the first healthy answer makes it `SUCCESS` |
| `docker build` fails | unchanged from Phase 4: `BUILDING → QUEUED → … → FAILED` with retries; no container, no health check, the stable version keeps running |
| Container exits before the health check | unchanged from Phase 4: `DEPLOYING → QUEUED → … → FAILED` with retries. The previous stable container was never touched, so there is nothing to roll back |
| Worker dies during a rollback | when BullMQ hands the job out again the deployment is set to `ROLLBACK_FAILED` (`the rollback did not complete`). A rollback is never run twice |
| Worker dies, or PostgreSQL is unreachable, during `BUILDING`, `DEPLOYING` or `HEALTH_CHECK` | nothing can be recorded, so the deployment is **not** marked `SUCCESS` even if the application answered. The job is run again, finds the interrupted status, goes back to `QUEUED` and starts over; the container of the interrupted attempt is replaced |
| Redis can't deliver events | statuses and logs are written to PostgreSQL first, so the outcome is unchanged. The log stream re-reads PostgreSQL every `LOG_STREAM_POLL_MS`, so the dashboard still gets every line, a little later. (Without Redis at all no job runs: BullMQ needs it, as since Phase 3) |
| Browser disconnects during a rollback | the rollback does not depend on anyone watching. The stream's Redis subscription is released; reopening the page resumes after the last line received (`Last-Event-ID`) |
| Several projects deploy at once | independent: see [Concurrent deployments](#concurrent-deployments) |

In every unhealthy case the unhealthy container is removed and its last 20 output lines are stored as `[container] …` log lines.

### Concurrent deployments

- **Different projects** are independent: the stable deployment is looked up by project ID.
- **The same project:** promoting a healthy deployment and rolling back an unhealthy one both change which deployment is live, so they run under a **per-project lock** (a PostgreSQL advisory lock, which also works across several worker processes). Either the healthy deployment is promoted first and the unhealthy one "rolls back" to it, or the unhealthy one is rolled back to the old stable deployment first and the healthy one is promoted afterwards. Both orders end with one container: the newest successful deployment.
- A deployment that is promoted only retires containers of **finished** deployments. A container that another job is still health-checking is left to that job.

### Safety

- **The target of a health check can't be chosen by a user.** The host comes from the worker's configuration and must be this machine or `HEALTH_CHECK_HOST`; the port is the one Docker assigned; the path is validated three times (API, database CHECK, worker) and can't contain a scheme, host, credentials, `//` or whitespace. Redirects are not followed, so an app can't bounce the worker to another address.
- **No shell, no user-supplied Docker arguments.** Rollback uses the existing `dockerService` (`spawn` with argument arrays).
- **No arbitrary container deletion.** A rollback removes the failed deployment's own container and, at most, a stopped container carrying the stable deployment's exact name. A promotion removes only containers labelled with the same project whose deployments are finished.
- **Nothing is reported as recovered unless the restored version passed its health check.**

**Limitation: the worker must be able to reach the published port.** App ports are bound to `127.0.0.1` on the Docker host. A worker on the host reaches them directly. The Compose worker uses `host.docker.internal`, which works on Docker Desktop (Windows, macOS). On plain Linux Docker Engine, `127.0.0.1`-bound ports are not reachable from a container, so run the worker on the host (`npm run dev:worker`) there.

### No health API

`GET /api/deployments/:id` already returns the outcome (`status`, `error_message`, `health_check`, `rollback_status`, `rollback_deployment_id`, `is_stable`), and every attempt with its status code and response time is in the logs. A separate `/health` endpoint would duplicate that, so none was added.

### How to test locally

```bash
docker compose up -d --build

# 1. A healthy version: becomes SUCCESS and stable
curl -s -X POST localhost:5000/api/projects -H "Content-Type: application/json" -d '{
  "name": "rollback-demo",
  "github_repo": "https://github.com/devtejasx/DeployX",
  "dockerfile_path": "examples/hello-app/Dockerfile",
  "container_port": 3000
}'
curl -s -X POST localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'

# 2. An unhealthy version of the same project: unhealthy-app answers GET /health with 503
curl -s -X PUT localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" \
  -d '{ "dockerfile_path": "examples/unhealthy-app/Dockerfile" }'
curl -s -X POST localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'

# 3. The second deployment is FAILED with rollback_status COMPLETED; the first is still live
curl -s localhost:5000/api/projects/<projectId>/deployments
curl -s http://127.0.0.1:<host_port of the first deployment>/        # Hello from DeployX
```

Open `http://localhost:3000` while step 2 runs to watch the attempts and the rollback live. What to look for:

1. First deployment: the steps reach `HEALTH_CHECK`, the health-check box counts attempts, then `SUCCESS` with a **Stable** tag.
2. Second deployment: five failed attempts (`503 Service Unavailable`), then `ROLLING_BACK` (↻), then `FAILED` with **Automatic rollback ✓ Completed** and a link to the restored deployment.
3. The log viewer shows every health-check and rollback line as it happens and ends with "The previous stable version was restored."
4. The history keeps both rows; the first is still **Stable** and still answers on its port.

Other scenarios:

- **No stable version:** deploy `unhealthy-app` as a project's first deployment → `FAILED`, rollback "Not available".
- **Restore from the image:** `docker rm -f <container_name of the stable deployment>` before step 2 → the rollback starts it again.
- **`ROLLBACK_FAILED`:** remove the stable container **and** its image before step 2 → the rollback has nothing to start:
  ```bash
  docker rm -f <container_name of the stable deployment>
  docker rmi -f $(docker image inspect --format '{{.Id}}' <repository>:deployment-<stable deployment id>)
  ```

## Dashboard (Phase 5)

`http://localhost:3000` has three parts under the system status card:

- **Applications:** your projects; pick one.
- **Deployment history:** that project's deployments, **newest first**. Each row shows its number (`#1` = oldest), short ID, commit, a status badge, created/started/finished time, duration, and the error for failed ones. **Deploy** queues a new deployment of the branch head. The list refreshes every 3 s while something is running, and immediately when the selected deployment changes status.
- **Deployment details:**
  - the lifecycle steps `QUEUED → BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS/FAILED`, status, full commit SHA, branch, timestamps, a running duration that ticks, image, container and local URL, and the error box for `FAILED`;
  - **live logs** that follow new lines (scroll up to pause) and show whether the stream is Live, Reconnecting or closed;
  - "Deployment completed successfully." or "Deployment failed." at the end.

**Phase 6 additions:**

- A running deployment shows what it is doing and the latest log line under the steps, for example **Running health checks…** / `Health check attempt 2/5 failed: Health check returned HTTP 503`.
- A **Health check** box shows the recorded details and follows them live: Running / Passed / Failed, `Attempt 3 / 5`, the last response (`200 OK · 38 ms`, or "No HTTP response") and the last error.
- `ROLLING_BACK` has its own badge (↻) and step: **Health check failed. Restoring the previous stable version…**
- A deployment that failed its health check shows the health check as the failed step and an **Automatic rollback** box: `✓ Completed` with a link to the **restored deployment**, `✗ Failed` with the rollback target, or `Not available` with "No previous stable deployment available for rollback."
- `ROLLBACK_FAILED` has its own badge and final step, and the log viewer ends with "…the automatic rollback failed: no healthy version is live."
- The project's last stable deployment carries a **Stable** tag in the history and in its details; failed rows show "Automatic rollback completed · restored #N", "Automatic rollback failed" or "No stable version to roll back to".
- The history header shows the project's health-check path.

None of this is computed in the browser: the steps, the boxes and the tag are read from `status`, `health_check`, `rollback_status`, `rollback_deployment_id` and `is_stable` as the API sends them.

The selection is in the URL (`#/projects/<id>/deployments/<id>`), so reloads and links keep it. All state comes from the API. The UI keeps no second copy of deployment status.

## Project Structure

```text
DeployX/
├── client/                         # React dashboard (Vite)
│   ├── public/
│   ├── src/
│   │   ├── api/                    # http.js (envelope), systemApi.js, deploymentsApi.js
│   │   ├── components/             # SystemStatus, ProjectList, DeploymentHistory, DeploymentDetails,
│   │   │                           # HealthCheckSummary, RollbackSummary, LogViewer, StatusSteps,
│   │   │                           # StatusBadge, StatusRow
│   │   ├── hooks/                  # useDeploymentStream (SSE), usePolling, useHashRoute, useSystemStatus
│   │   ├── utils/format.js         # dates, durations, short ids
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── vite.config.js              # dev server on :3000, /api proxy
│   └── Dockerfile
│
├── server/                         # Express API
│   ├── src/
│   │   ├── config/index.js         # environment configuration
│   │   ├── controllers/            # health, system, project, deployment, log
│   │   ├── routes/                 # one router per resource + index.js
│   │   ├── services/               # business logic + SQL (project, deployment, log, user, systemStatus)
│   │   ├── validators/             # zod schemas for request bodies
│   │   ├── middleware/
│   │   │   ├── validation.js       # validate({ params, body })
│   │   │   ├── devUser.js          # TEMPORARY current-user stand-in
│   │   │   ├── notFound.js
│   │   │   └── errorHandler.js     # single error format, DB error mapping
│   │   ├── utils/                  # ApiError, sendSuccess
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
│   │   │   ├── dockerDeployment.js     # clone → checkout → build → run → verify running
│   │   │   └── release.js              # health check → SUCCESS and retire the previous container, or rollback
│   │   ├── services/
│   │   │   ├── deploymentService.js    # status + logs + container tracking + stable lookup in PostgreSQL
│   │   │   ├── healthCheckService.js   # one HTTP health check; retries, interval, grace period
│   │   │   ├── rollbackService.js      # restore and verify the last stable deployment
│   │   │   ├── gitService.js           # safe clone + exact commit checkout
│   │   │   ├── dockerService.js        # image/container naming, build, restricted run
│   │   │   └── workspace.js            # per-deployment workspace, path + Dockerfile checks
│   │   ├── lib/
│   │   │   ├── exec.js                 # spawn without a shell, env allowlist, timeouts
│   │   │   ├── buildLog.js             # build output filtering and limits
│   │   │   └── errors.js               # RecordedFailureError: failed for good, already recorded
│   │   ├── config/
│   │   │   ├── index.js            # environment configuration
│   │   │   └── redis.js            # ioredis connection factory
│   │   └── db/postgres.js          # pool, query(), per-project advisory lock
│   └── Dockerfile                  # adds git + Docker CLI (buildx)
│
├── examples/                       # test apps for deployments (hello-app, unhealthy-app, crash-app, broken-dockerfile)
├── docker-compose.yml
├── .env.example
└── package.json                    # convenience scripts for the whole repo
```

## Prerequisites

- **Node.js 20.12 or newer** (22 LTS recommended) and npm
- **Docker** with the Compose plugin (Docker Desktop on Windows/macOS)
- **Git**

## Environment Variables

```bash
cp .env.example .env
```

`.env` is git-ignored. Only `.env.example` is committed, and it contains only local development defaults.

| Variable            | Default                                                | Used by                    |
| ------------------- | ------------------------------------------------------ | -------------------------- |
| `NODE_ENV`          | `development`                                          | server, worker             |
| `PORT`              | `5000`                                                 | server (also host port)    |
| `CLIENT_URL`        | `http://localhost:3000`                                | server (CORS origin)       |
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
| `APP_MEMORY_LIMIT` / `APP_CPU_LIMIT` | `512m` / `1`                       | worker: limits per app container |
| `WORKSPACE_ROOT`    | `<os temp>/deployx-workspaces`                      | worker: where repositories are cloned |
| `DOCKER_SOCKET_GID` | `0`                                                 | Compose: group owning the Docker socket |
| `LOG_STREAM_POLL_MS` | `2000`                                              | server: live streams re-check the database this often (safety net for missed events) |
| `LOG_STREAM_HEARTBEAT_MS` | `15000`                                        | server: keep-alive comment interval on live streams |
| `DEV_USER_EMAIL`    | `dev@deployx.local`                                    | temporary current user     |
| `DEV_USER_NAME`     | `DeployX Developer`                                    | temporary current user     |
| `POSTGRES_USER`     | `deployx`                                              | postgres container         |
| `POSTGRES_PASSWORD` | `deployx`                                              | postgres container         |
| `POSTGRES_DB`       | `deployx`                                              | postgres container         |
| `REDIS_PASSWORD`    | `deployx-dev-redis`                                    | redis container (`requirepass`); must match `REDIS_URL` |
| `POSTGRES_PORT`     | `5432`                                                 | host port for PostgreSQL   |
| `REDIS_PORT`        | `6379`                                                 | host port for Redis        |
| `TEST_DATABASE_URL` | `DATABASE_URL` + `_test`                               | integration tests only     |

Inside Docker Compose the API, the worker and the migrate job get `DATABASE_URL` and `REDIS_URL` pointing at the `postgres` and `redis` containers automatically.

### Temporary user (no authentication yet)

Authentication is a later phase. Until then, **every API request acts as a single development user**, identified by `DEV_USER_EMAIL`. The [`devUser`](server/src/middleware/devUser.js) middleware creates that user on first use and attaches it as `req.user`. Services already scope every query by `req.user.id`, so real authentication can replace this one middleware without changing them. Don't expose this API publicly in this state.

## Local Development

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

## Running with Docker Compose

```bash
cp .env.example .env      # optional - Compose falls back to the same defaults
docker compose up --build
```

| Service    | Image / build        | Host port | Notes                                              |
| ---------- | -------------------- | --------- | -------------------------------------------------- |
| `postgres` | `postgres:17-alpine` | 127.0.0.1:5432 | `postgres-data` volume, healthcheck |
| `redis`    | `redis:7-alpine`     | 127.0.0.1:6379 | `redis-data` volume, healthcheck, **password required** |
| `migrate`  | `./server`           | -              | applies migrations, then exits with code 0 |
| `server`   | `./server`           | 127.0.0.1:5000 | starts after `migrate` succeeds and the DBs are healthy |
| `client`   | `./client`           | 127.0.0.1:3000 | Vite dev server, proxies `/api` to `server` |
| `worker`   | `./worker`           | -              | runs deployments; **the only service with the Docker socket**; health-checks apps through `host.docker.internal`; 30 s stop grace period |

Deployed apps are **not** Compose services. The worker starts them on the `deployx-apps` network, so `docker compose down` leaves them running. Remove them with `docker rm -f $(docker ps -aq --filter label=deployx.managed=true)`.

```bash
docker compose ps -a              # service status (including the finished migrate job)
docker compose logs -f server     # follow API logs
docker compose logs -f worker     # follow job processing
docker compose down               # stop everything (keeps data volumes)
docker compose down -v            # stop and delete the database/redis volumes
```

Images aren't rebuilt when you edit code. Run `docker compose up --build` again after a change.

## API

### Response format

Every endpoint returns the same envelope.

```json
{ "success": true, "data": { } }
```

```json
{ "success": false, "error": { "message": "Project not found" } }
```

Validation failures add `details`, with one readable message per problem:

```json
{
  "success": false,
  "error": {
    "message": "Validation failed",
    "details": ["Project name is required", "GitHub repository URL is required"]
  }
}
```

| Code | When |
| ---- | ---- |
| 200 | success |
| 201 | resource created |
| 400 | validation failed, malformed ID, or malformed JSON |
| 404 | resource or route not found |
| 409 | conflict: duplicate project name, deploying an inactive project, or an invalid deployment state transition (response includes `from` and `to`) |
| 500 | unexpected error; the response says `Internal server error`, and details go only to the server log |
| 503 | `/api/system/status`: PostgreSQL or Redis unreachable; creating a deployment: job queue unavailable |

Rules that apply to every endpoint:

- IDs in the URL must be UUIDs. A malformed ID returns 400, and a well-formed ID that doesn't exist returns 404.
- Request bodies must be JSON objects. Unknown or read-only fields (`id`, `user_id`, `created_at`, `updated_at`, and so on) are rejected.
- All SQL is parameterized. User input is never concatenated into queries.

### Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/health` | API liveness |
| GET | `/api/system/status` | live PostgreSQL + Redis check |
| POST | `/api/projects` | create a project |
| GET | `/api/projects` | list projects (newest first) |
| GET | `/api/projects/:id` | get one project |
| PUT | `/api/projects/:id` | update a project (partial) |
| DELETE | `/api/projects/:id` | delete a project, its deployments and their logs |
| POST | `/api/projects/:projectId/deployments` | create a deployment record (`QUEUED`) |
| GET | `/api/projects/:projectId/deployments` | list a project's deployments (newest first) |
| GET | `/api/deployments/:deploymentId` | get one deployment, including a project summary |
| PATCH | `/api/deployments/:deploymentId/status` | update deployment status |
| POST | `/api/deployments/:deploymentId/logs` | add a log line |
| GET | `/api/deployments/:deploymentId/logs` | list log lines (chronological) |
| GET | `/api/deployments/:deploymentId/logs/stream` | live logs and status as Server-Sent Events ([details](#real-time-deployment-logs-phase-5)) |

### Health and status

`GET /api/health` → `200`

```json
{ "success": true, "data": { "status": "ok", "service": "deployx-api", "timestamp": "2026-09-25T10:04:44.454Z" } }
```

`GET /api/system/status` → `200` when everything is reachable, `503` otherwise. `data` always contains the per-service result:

```json
{
  "success": true,
  "data": { "api": "connected", "database": "connected", "redis": "connected", "checkedAt": "2026-09-25T10:04:44.539Z" }
}
```

### Projects

**Create**: `POST /api/projects` → `201`

| Field | Required | Rules |
| ----- | -------- | ----- |
| `name` | yes | 1–100 characters after trimming; unique per user (else `409`) |
| `github_repo` | yes | `https://github.com/<owner>/<repo>` (`.git` or a trailing `/` is accepted and removed) |
| `description` | no | up to 1000 characters; `""` or `null` clears it |
| `github_branch` | no | valid git branch name, default `main` |
| `dockerfile_path` | no | relative path inside the repo (no leading `/`, no `..`), default `Dockerfile` |
| `container_port` | **yes** | integer 1–65535: the port the app listens on inside its container |
| `health_check_path` | no | absolute path the worker requests to check the app's health, default `/health`. Letters, digits, `. _ ~ -` and `/`, plus an optional query string; no host, no `//`, at most 255 characters |
| `status` | no | `ACTIVE` (default) or `INACTIVE` |

```bash
curl -X POST http://localhost:5000/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My API",
    "description": "My backend application",
    "github_repo": "https://github.com/example/my-api",
    "github_branch": "main",
    "dockerfile_path": "Dockerfile",
    "container_port": 3000
  }'
```

```json
{
  "success": true,
  "data": {
    "id": "9eac077c-992d-4e54-b682-b2f9ae11d48f",
    "user_id": "9db9df92-b8e4-4885-9ea4-910decb08f21",
    "name": "My API",
    "description": "My backend application",
    "github_repo": "https://github.com/example/my-api",
    "github_branch": "main",
    "dockerfile_path": "Dockerfile",
    "container_port": 3000,
    "health_check_path": "/health",
    "status": "ACTIVE",
    "created_at": "2026-09-25T10:06:11.680Z",
    "updated_at": "2026-09-25T10:06:11.680Z"
  }
}
```

**List**: `GET /api/projects` → `200`, `data` is an array of projects, newest first.

**Get**: `GET /api/projects/:id` → `200`, or `404` `{"success":false,"error":{"message":"Project not found"}}`.

**Update**: `PUT /api/projects/:id` → `200` with the updated project. Send any subset of the create fields (at least one). Fields you leave out stay unchanged.

```bash
curl -X PUT http://localhost:5000/api/projects/<id> \
  -H "Content-Type: application/json" \
  -d '{ "description": "Updated", "status": "INACTIVE" }'
```

**Delete**: `DELETE /api/projects/:id` → `200`

```json
{ "success": true, "data": { "id": "9eac077c-992d-4e54-b682-b2f9ae11d48f", "deleted": true } }
```

### Deployments

Creating a deployment queues a background job (see [Deployment Jobs](#deployment-jobs-bullmq)). The API itself never clones, builds or runs anything. The worker does, as described in [Docker Deployments](#docker-deployments-phase-4).

**Create**: `POST /api/projects/:projectId/deployments` → `201` once the job is queued; the response does not wait for the job to run.

| Field | Required | Rules |
| ----- | -------- | ----- |
| `commit_sha` | no | 7–40 hex characters (stored lower-case) |
| `branch` | no | valid git branch name; defaults to the project's `github_branch` |

`status` can't be set here. Every new deployment starts as `QUEUED`. Returns `404` if the project doesn't exist, `409` if the project is `INACTIVE`, and `503` if the job queue (Redis) is unavailable. In the `503` case the deployment is recorded as `FAILED`.

```bash
curl -X POST http://localhost:5000/api/projects/<projectId>/deployments \
  -H "Content-Type: application/json" \
  -d '{ "commit_sha": "abc1234", "branch": "main" }'
```

```json
{
  "success": true,
  "data": {
    "deployment": {
      "id": "69bb15c5-7084-457e-9c6e-8b3a9586927c",
      "project_id": "391710c4-fda1-48d7-bb50-894de0bf7878",
      "commit_sha": "abc1234",
      "branch": "main",
      "status": "QUEUED",
      "docker_image": null,
      "container_id": null,
      "container_name": null,
      "host_port": null,
      "container_removed_at": null,
      "error_message": null,
      "health_check": null,
      "rollback_status": null,
      "rollback_deployment_id": null,
      "is_stable": false,
      "started_at": null,
      "finished_at": null,
      "created_at": "2026-09-25T10:07:19.005Z",
      "updated_at": "2026-09-25T10:07:19.005Z",
      "project": { "id": "391710c4-fda1-48d7-bb50-894de0bf7878", "name": "My API", "github_repo": "https://github.com/example/my-api" }
    },
    "jobId": "69bb15c5-7084-457e-9c6e-8b3a9586927c"
  }
}
```

`jobId` is the BullMQ job ID, which is always the deployment ID. Follow progress with `GET /api/deployments/:deploymentId` and `GET /api/deployments/:deploymentId/logs`.

**List**: `GET /api/projects/:projectId/deployments` → `200`, the project's deployments newest first (`404` if the project doesn't exist). At most one of them has `is_stable: true`: the project's last stable deployment.

**Get**: `GET /api/deployments/:deploymentId` → `200` with the same fields as the `deployment` in the create response. Once the worker has run, it shows the real outcome: resolved `commit_sha`, `docker_image`, `container_id`, `container_name`, `host_port`, `error_message` and timestamps (example in [Deployment lifecycle](#deployment-lifecycle)). `health_check` holds the recorded health-check details (see [Health checks and retries](#health-checks-and-retries)). For a deployment that failed its health check, `rollback_status` and `rollback_deployment_id` report what the automatic rollback did (see [Rollback](#rollback)); `is_stable` tells whether this is the project's last stable deployment.

**Update status**: `PATCH /api/deployments/:deploymentId/status` → `200` with the updated deployment

```bash
curl -X PATCH http://localhost:5000/api/deployments/<deploymentId>/status \
  -H "Content-Type: application/json" \
  -d '{ "status": "BUILDING" }'
```

Only `QUEUED`, `BUILDING`, `DEPLOYING`, `HEALTH_CHECK`, `ROLLING_BACK`, `SUCCESS`, `FAILED` and `ROLLBACK_FAILED` are accepted. Anything else returns `400`. The timestamps follow the status:

- `started_at` is set when work first begins (`BUILDING`), and kept if the deployment goes back to `QUEUED` for a retry. A deployment that fails straight from `QUEUED` has no `started_at`.
- `finished_at` is set on `SUCCESS`, `FAILED` or `ROLLBACK_FAILED` and cleared for any other status.

Only transitions allowed by the [state machine](#state-machine) are accepted. Anything else returns **409** with `from` and `to`; for example `DEPLOYING → SUCCESS`, which has to go through `HEALTH_CHECK`. Setting the current status again is a no-op (`200`).

Since Phase 3 the **worker** sets these statuses as it processes the job, so this endpoint is a manual override. It isn't coordinated with a job that is currently running, and the worker's next stage overwrites it. Setting `SUCCESS` or `FAILED` before the job starts makes the worker skip it.

### Deployment logs

**Add**: `POST /api/deployments/:deploymentId/logs` → `201`

| Field | Required | Rules |
| ----- | -------- | ----- |
| `level` | yes | `INFO`, `WARN` or `ERROR` |
| `message` | yes | 1–10000 characters, not blank; stored verbatim |

```bash
curl -X POST http://localhost:5000/api/deployments/<deploymentId>/logs \
  -H "Content-Type: application/json" \
  -d '{ "level": "INFO", "message": "Deployment created" }'
```

```json
{
  "success": true,
  "data": {
    "id": "1",
    "deployment_id": "69bb15c5-7084-457e-9c6e-8b3a9586927c",
    "level": "INFO",
    "message": "Deployment created",
    "created_at": "2026-09-25T10:08:05.966Z"
  }
}
```

Log IDs are 64-bit integers and are returned as strings, so no precision is lost in JavaScript.

**List**: `GET /api/deployments/:deploymentId/logs` → `200`, all log lines in the order they were written. For live output, use `GET /api/deployments/:deploymentId/logs/stream` (Server-Sent Events, see [Real-Time Deployment Logs](#real-time-deployment-logs-phase-5)).

## Testing

The tests start the real Express app on a random port and send HTTP requests to it. The queue tests also run the **real worker in the same process**. Everything is isolated from development data:

- a **separate test database**: `TEST_DATABASE_URL`, or your `DATABASE_URL` with `_test` appended (for example `deployx_test`). It is created if needed, migrated and emptied before each test file.
- a **separate queue prefix** (`deployx-test`), emptied before each test file.
- short timings: the retry backoff is 200 ms, then 400 ms. The queue tests use a fast fake pipeline ([`fakePipeline.js`](server/test/fakePipeline.js)) instead of Docker.
- the health-check and rollback tests run the worker's real release stage against a fake Docker ([`fakeDocker.js`](server/test/fakeDocker.js)) whose "containers" are real HTTP servers in the test process, so real health checks hit them.

```bash
npm run install:all       # the queue tests load the worker's dependencies too
npm run infra:up          # PostgreSQL + Redis must be running
npm test                  # = npm --prefix server test
```

The default suite (200 tests, about 45 s, no Docker or network needed) covers:

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
- **health checks** ([`health-check.test.js`](server/test/health-check.test.js)): 200, 201 and 204 healthy; 400, 404, 500 and 503 unhealthy; redirects unhealthy and never followed; timeout; connection refused; a non-HTTP server; configurable path; a retry that succeeds; all retries failing; the interval; the startup grace period; bounded attempts; rejected hosts, ports and paths (no request is sent)
- **stable deployments** ([`stable-deployments.test.js`](server/test/stable-deployments.test.js)): none without a success; the newest success replaces the previous one, whose record stays untouched; failed and rolled-back deployments never become stable; tracked per project; `is_stable` and the rollback fields in the API
- **health check and rollback, end to end** ([`rollback.test.js`](server/test/rollback.test.js), API → BullMQ → worker → PostgreSQL → Redis → SSE):
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

### Docker end-to-end tests

These tests run the **real pipeline**: they clone this repository from GitHub, build the [example apps](examples) with Docker and start containers. They need network access and a Docker daemon, so they're **opt-in**:

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

They use their own image prefix (`deployx-test/`) and network (`deployx-apps-test`), and they remove everything they created. They clone the `main` branch; set `DEPLOYX_TEST_BRANCH` to test example apps from another branch.

### Manual verification with Docker

Follow [Local setup and the test repository](#local-setup-and-the-test-repository) to deploy `hello-app`, then try the failing examples: `examples/crash-app/Dockerfile`, `examples/broken-dockerfile/Dockerfile`, a non-existent `dockerfile_path`, or a `commit_sha` that doesn't exist. For health checks and rollback, follow [How to test locally](#how-to-test-locally). Useful commands:

```bash
docker compose logs -f worker                                   # jobs starting, retrying, completing
docker ps --filter label=deployx.managed=true                   # running app containers
docker compose stop worker                                      # graceful: waits for the running job
```

To try the API by hand, use the `curl` examples above against `http://localhost:5000`. Through the dashboard's proxy, `http://localhost:3000/api/...` works too.

## Troubleshooting

**PostgreSQL port not published on Windows.** Hyper-V/WSL reserves blocks of TCP ports, and the block can include 5432. When that happens, `docker compose ps` shows `5432/tcp` with no host mapping, and local tools get `ECONNREFUSED`. Check with:

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

If 5432 is inside one of the ranges, pick a free port in `.env`. Set both `POSTGRES_PORT` and the port in `DATABASE_URL`, for example `15432`, then run `docker compose up -d postgres`.

**Worker says `docker is not usable` / `permission denied … docker.sock`.** In Docker Compose, set `DOCKER_SOCKET_GID` to the group that owns the socket (`stat -c %g /var/run/docker.sock` on Linux; `0` on Docker Desktop). Outside Docker, make sure `docker version` works in the shell that starts `npm run dev:worker`.

**`NOAUTH Authentication required` from Redis.** Since Phase 4 Redis needs a password. Make `REDIS_URL` in `.env` include `REDIS_PASSWORD`: `redis://:<password>@localhost:6379`.

**Deployment fails with `Health check failed after 5 attempts`.** The container runs, but the health check did not get a 2xx answer. The attempt lines in the logs say why:
- `Health check returned HTTP 404`: the app has no `/health` endpoint. Add one, or set the project's `health_check_path` to a path that answers 200 (`PUT /api/projects/:id` with `{"health_check_path": "/"}`).
- `Connection refused` or `Connection closed before a response was received`: nothing listens on `container_port` inside the container, or the app only listens on `127.0.0.1` instead of `0.0.0.0`.
- `Health check timed out`: the app needs longer to start or to answer. Raise `HEALTH_CHECK_STARTUP_GRACE_MS`, `HEALTH_CHECK_RETRIES` or `HEALTH_CHECK_TIMEOUT_MS`.
- Every deployment fails with `Connection refused` when the worker runs in Docker Compose on Linux: the worker container can't reach ports bound to the host's `127.0.0.1`. Run the worker on the host (`npm run dev:worker`).

**Deployment fails with `Project has no container_port configured`.** Projects created before Phase 4 have no port. Set it with `PUT /api/projects/:id` and `{"container_port": 3000}`.

## Project Status

**Phase 1: foundation**

- [x] React dashboard showing live API / database / Redis status
- [x] Express API with `/api/health` and `/api/system/status`
- [x] PostgreSQL and Redis connection modules
- [x] Worker foundation that starts and shuts down cleanly
- [x] Docker Compose for the full stack

**Phase 2: database and REST API**

- [x] Migrations for `users`, `projects`, `deployments`, `deployment_logs`
- [x] Foreign keys with cascading deletes, CHECK constraints, indexes
- [x] Project CRUD
- [x] Deployment records: create, list, get, status update
- [x] Deployment logs: add and list
- [x] Request validation and a single response format
- [x] Integration tests against PostgreSQL

**Phase 3: job queue and worker**

- [x] BullMQ `deployments` queue on the existing Redis (one API connection)
- [x] Deployment creation queues a job (job ID = deployment ID) and returns immediately
- [x] Worker with concurrency 2 and a clearly marked simulated pipeline (replaced by the Docker pipeline in Phase 4)
- [x] Status and logs written to PostgreSQL at every stage
- [x] 3 attempts with exponential backoff, final `FAILED` with a log
- [x] One failed job doesn't affect other jobs or the worker
- [x] Duplicate jobs are prevented; finished or deleted deployments are skipped
- [x] Graceful shutdown on `SIGTERM`/`SIGINT`
- [x] End-to-end tests (API → BullMQ → Redis → worker → PostgreSQL)
- [x] No Docker builds, git clones, AWS or webhooks (later phases)

**Phase 4: Docker-based deployment**

- [x] Public GitHub repositories cloned into per-deployment workspaces
- [x] Exact commit checked out (and recorded when none was requested)
- [x] Dockerfile validated before building
- [x] Image built and tagged with the commit SHA
- [x] Container started on an isolated network with a declared `container_port`, verified running, tracked in PostgreSQL
- [x] Previous container replaced; deployment history kept
- [x] Build, checkout and startup failures end `FAILED` with a reason; BullMQ retries for transient failures
- [x] Workspaces always cleaned up; build logs limited
- [x] Unprivileged, secret-free, resource-limited app containers; Redis password; services on 127.0.0.1
- [x] Unit tests and opt-in Docker end-to-end tests
- [x] No health checks, rollback, real-time logs, webhooks, OAuth or AWS (later phases)

**Phase 5: state machine, deployment history, real-time logs**

- [x] Transition map in one table, enforced by a PostgreSQL trigger for every writer
- [x] `transitionDeploymentStatus()` used by the API and the worker; no direct status writes; invalid transitions → 409 / unrecoverable job error
- [x] Log lines and status changes published to per-deployment Redis channels
- [x] SSE endpoint: backlog, live updates, `Last-Event-ID` resume, closes on final status, subscriptions cleaned up on disconnect, database fallback when Redis is down
- [x] Dashboard: applications, deployment history (newest first), details with live logs, lifecycle steps and errors
- [x] Tests for the state machine, events and stream; Phase 1–4 tests and Docker e2e tests still pass
- [x] No health checks, rollback, webhooks, OAuth or AWS (later phases)

**Phase 6: health checks and automatic rollback**

- [x] Health checks: configurable endpoint, timeout, retries, interval and startup grace period; failures never crash the worker
- [x] State machine: `HEALTH_CHECK` in use, `ROLLING_BACK` and the final `ROLLBACK_FAILED` added, `SUCCESS` only reachable through the health check, invalid transitions rejected
- [x] Stable version: a healthy successful deployment becomes stable; tracked per project; derived, so history is never rewritten
- [x] Automatic rollback: unhealthy deployment detected, last stable deployment found, restored (still running or restarted from its image) and health-checked
- [x] Outcomes reported: rollback completed, rollback failed (`ROLLBACK_FAILED`), no stable version
- [x] Health-check details (attempts, status code, response time, error) recorded per deployment and streamed live
- [x] Fails safely when Redis events, PostgreSQL or the worker are interrupted: no false `SUCCESS`, interrupted attempts are run again
- [x] Health-check and rollback logs streamed through the existing Redis Pub/Sub + SSE pipeline; no second event system
- [x] Dashboard: health-check progress, rolling back, rollback outcome, restored deployment, stable tag
- [x] Unit, integration and rollback end-to-end tests; Phase 1–5 tests and the Docker e2e tests pass
- [x] No GitHub OAuth or webhooks, private repositories, AWS, Kubernetes or monitoring (later phases)

## Future Phases

DeployX is developed incrementally across **8 phases**:

| Phase | Focus                                                                 |
| ----- | --------------------------------------------------------------------- |
| 1     | Project foundation ✅                                                 |
| 2     | Data model and REST API ✅                                            |
| 3     | Job queue: BullMQ on Redis, worker job processing, retries, concurrency ✅ |
| 4     | Build & run: git clone, Docker build, container deployment ✅         |
| 5     | Deployment history, state machine, real-time logs (SSE) ✅            |
| **6** | **Health checks for deployed apps, automatic rollback, stable versions (this phase)** ✅ |
| 7     | GitHub OAuth & webhooks, AWS / EC2 cloud deployment                   |
| 8     | Production auth, security hardening, monitoring, CI/CD                |
