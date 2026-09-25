# DeployX

A self-service deployment platform: connect a GitHub repository, build it into a Docker image, deploy it, watch it run and roll back automatically when a release goes bad.

> **Status: Phase 3 of 8. Job queue and deployment worker.** DeployX is being built one phase at a time. Creating a deployment now queues a real background job (BullMQ on Redis), which a separate worker process picks up, retries and tracks in PostgreSQL. **The deployment work itself is still simulated.** The worker doesn't clone repositories, build images or start containers yet. That's Phase 4.

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
                       │  ┌──────────────────────────┐
                       │  │  worker  (Node.js)       │  simulated pipeline
                       │  └────────────┬─────────────┘
                       ▼               │ status + logs (SQL)
             ┌──────────────┐          │
             │  PostgreSQL  │◀─────────┘
             │    :5432     │
             └──────▲───────┘
                    │ applies migrations, then exits
             ┌──────┴───────┐
             │   migrate    │  (one-shot job in Docker Compose)
             └──────────────┘
```

The browser only talks to the client. The Vite dev server forwards `/api/*` requests to the API, so the frontend never contains a hard-coded backend URL.

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
| Worker         | Node.js, BullMQ 6, `ioredis`, `pg`           |
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
| `status` | `varchar(20)` | `ACTIVE` \| `INACTIVE` (CHECK), default `ACTIVE` |
| `created_at`, `updated_at` | `timestamptz` | |

**`deployments`**

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `uuid` | primary key |
| `project_id` | `uuid` | FK → `projects.id` |
| `commit_sha` | `varchar(40)` | nullable; 7–40 lower-case hex (CHECK) |
| `branch` | `varchar(255)` | |
| `status` | `varchar(20)` | `QUEUED` \| `BUILDING` \| `DEPLOYING` \| `HEALTH_CHECK` \| `SUCCESS` \| `FAILED` (CHECK), default `QUEUED` |
| `docker_image` | `varchar(255)` | nullable; filled in by the build phase later |
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

### Indexes

| Index | Serves |
| ----- | ------ |
| `users_email_key` (unique) | look up a user by email |
| `projects_user_id_name_key` (unique `user_id, name`) | "projects of this user", and per-user unique names |
| `deployments_project_id_created_at_idx` (`project_id, created_at DESC`) | "deployments of a project, newest first" |
| `deployment_logs_deployment_id_id_idx` (`deployment_id, id`) | "logs of a deployment in order" |

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
 │        QUEUED → BUILDING → DEPLOYING → SUCCESS      (simulated stages)
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

A successful deployment writes these logs:

```text
10:58:14.784 INFO  Deployment created                                        ← API
10:58:14.812 INFO  Deployment job started (attempt 1 of 3)                   ← worker
10:58:14.818 INFO  Deployment is now building                                  status BUILDING, started_at set
10:58:15.829 INFO  Build simulation completed (no image was built)
10:58:15.834 INFO  Deployment is now deploying                                 status DEPLOYING
10:58:16.850 INFO  Deployment simulation completed (no container was started)
10:58:16.860 INFO  Deployment completed successfully                           status SUCCESS, finished_at set
```

`HEALTH_CHECK` is not used yet. It arrives with real health checks in Phase 6.

> **Simulation.** [`deploymentProcessor.js`](worker/src/processors/deploymentProcessor.js) only waits `SIMULATION_STEP_MS` per stage. It doesn't run `git`, `docker` or anything on AWS. Phase 4 replaces the simulated stages with the real build and run pipeline.

### Retries

| Setting | Value | Configured by |
| ------- | ----- | ------------- |
| Attempts | 3 (first run included) | `DEPLOYMENT_JOB_ATTEMPTS` (API) |
| Backoff | exponential: 2 s, then 4 s | `DEPLOYMENT_JOB_BACKOFF_MS` (API) |

When an attempt fails:

1. The worker logs `ERROR Attempt n of 3 failed: <reason>`.
2. If attempts remain, the deployment goes back to **`QUEUED`** and gets `WARN Retrying in 2s (attempt 2 of 3)`. `started_at` keeps the time of the first attempt. BullMQ re-runs the job after the backoff.
3. After the last attempt, the deployment becomes **`FAILED`** (with `finished_at`) and gets `ERROR Deployment failed after maximum retry attempts`. The BullMQ job ends in its `failed` state.

Some errors can't be fixed by trying again, so they fail right away without retries. Examples: the deployment was deleted while the job ran, or the job has an unknown name.

**Deterministic test failures (simulation only).** The deployment's branch decides:

| Branch | Behaviour |
| ------ | --------- |
| `simulate/fail` | the simulated build fails on every attempt, so the deployment ends `FAILED` after 3 attempts |
| `simulate/flaky` | fails on attempts 1 and 2 and succeeds on attempt 3, so it ends `SUCCESS` |
| anything else | never fails |

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

## Project Structure

```text
DeployX/
├── client/                         # React dashboard (Vite)
│   ├── public/
│   ├── src/
│   │   ├── api/systemApi.js        # GET /api/system/status
│   │   ├── components/StatusRow.jsx
│   │   ├── hooks/useSystemStatus.js
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
│   ├── test/                       # integration + end-to-end tests (node:test)
│   └── Dockerfile
│
├── worker/                         # deployment worker
│   ├── src/
│   │   ├── index.js                # entry point: start, SIGTERM/SIGINT shutdown
│   │   ├── worker.js               # BullMQ Worker, concurrency, event handlers
│   │   ├── processors/
│   │   │   ├── deploymentProcessor.js  # SIMULATED pipeline + retry bookkeeping
│   │   │   └── simulatedFailures.js    # deterministic failures for testing
│   │   ├── services/
│   │   │   └── deploymentService.js    # status updates + logs in PostgreSQL
│   │   ├── config/
│   │   │   ├── index.js            # environment configuration
│   │   │   └── redis.js            # ioredis connection factory
│   │   └── db/postgres.js
│   └── Dockerfile
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
| `REDIS_URL`         | `redis://localhost:6379`                               | server, worker (local)     |
| `QUEUE_PREFIX`      | `deployx`                                              | server + worker (must match) |
| `DEPLOYMENT_JOB_ATTEMPTS` | `3`                                              | server (job options)       |
| `DEPLOYMENT_JOB_BACKOFF_MS` | `2000`                                         | server (exponential base)  |
| `WORKER_CONCURRENCY` | `2`                                                   | worker                     |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `25000`                                       | worker                     |
| `SIMULATION_STEP_MS` | `2000`                                                | worker (simulated stage length) |
| `DEV_USER_EMAIL`    | `dev@deployx.local`                                    | temporary current user     |
| `DEV_USER_NAME`     | `DeployX Developer`                                    | temporary current user     |
| `POSTGRES_USER`     | `deployx`                                              | postgres container         |
| `POSTGRES_PASSWORD` | `deployx`                                              | postgres container         |
| `POSTGRES_DB`       | `deployx`                                              | postgres container         |
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
| `postgres` | `postgres:17-alpine` | 5432      | `postgres-data` volume, healthcheck                |
| `redis`    | `redis:7-alpine`     | 6379      | `redis-data` volume, healthcheck                   |
| `migrate`  | `./server`           | -         | applies migrations, then exits with code 0         |
| `server`   | `./server`           | 5000      | starts after `migrate` succeeds and the DBs are healthy |
| `client`   | `./client`           | 3000      | Vite dev server, proxies `/api` to `server`        |
| `worker`   | `./worker`           | -         | processes deployment jobs; starts after `migrate`; 30 s stop grace period |

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
| 409 | conflict: duplicate project name, or deploying an inactive project |
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
| `status` | no | `ACTIVE` (default) or `INACTIVE` |

```bash
curl -X POST http://localhost:5000/api/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My API",
    "description": "My backend application",
    "github_repo": "https://github.com/example/my-api",
    "github_branch": "main",
    "dockerfile_path": "Dockerfile"
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

Creating a deployment queues a background job (see [Deployment Jobs](#deployment-jobs-bullmq)). The API itself never clones, builds or runs anything, and in Phase 3 the worker only simulates those steps.

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

**List**: `GET /api/projects/:projectId/deployments` → `200`, the project's deployments newest first (`404` if the project doesn't exist).

**Get**: `GET /api/deployments/:deploymentId` → `200` with the same shape as the create response.

**Update status**: `PATCH /api/deployments/:deploymentId/status` → `200` with the updated deployment

```bash
curl -X PATCH http://localhost:5000/api/deployments/<deploymentId>/status \
  -H "Content-Type: application/json" \
  -d '{ "status": "BUILDING" }'
```

Only `QUEUED`, `BUILDING`, `DEPLOYING`, `HEALTH_CHECK`, `SUCCESS` and `FAILED` are accepted. Anything else returns `400`. The timestamps follow the status:

- `started_at` is set the first time a deployment leaves `QUEUED`. Setting it back to `QUEUED` clears it.
- `finished_at` is set on `SUCCESS` or `FAILED` and cleared for any other status.

Which transitions are allowed (for example, `SUCCESS` → `BUILDING`) is not enforced yet. The deployment state machine is part of a later phase.

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

**List**: `GET /api/deployments/:deploymentId/logs` → `200`, all log lines in the order they were written. Real-time streaming is not part of this phase.

## Testing

The tests start the real Express app on a random port and send HTTP requests to it. The queue tests also run the **real worker in the same process**. Everything is isolated from development data:

- a **separate test database**: `TEST_DATABASE_URL`, or your `DATABASE_URL` with `_test` appended (for example `deployx_test`). It is created if needed, migrated and emptied before each test file.
- a **separate queue prefix** (`deployx-test`), emptied before each test file.
- short timings: simulated stages take 300 ms, and the retry backoff is 200 ms, then 400 ms.

```bash
npm run install:all       # the queue tests load the worker's dependencies too
npm run infra:up          # PostgreSQL + Redis must be running
npm test                  # = npm --prefix server test
```

The suite (55 tests, about 17 s) covers:

- every endpoint with valid requests
- missing and invalid fields, read-only fields, and non-object bodies
- malformed and non-existent IDs for projects and deployments
- duplicate project names and deploying an inactive project
- invalid deployment statuses and log levels
- the schema itself: tables, indexes, foreign keys, CHECK constraints, and cascade on delete
- database failures, which must return a generic `500` without leaking internal details
- **queue:** the job ID, payload and retry options of every queued job; `503` + `FAILED` when the queue is down
- **single job:** the API answers before the job runs, then `QUEUED → BUILDING → DEPLOYING → SUCCESS` with timestamps and the exact log sequence
- **concurrency:** 4 deployments give 2 running and 2 waiting, never more than 2 active, and jobs 3–4 start only after one of the first two finishes
- **retries:** `simulate/fail` shows attempts 1, 2 and 3, then `FAILED`; `simulate/flaky` succeeds on attempt 3
- **isolation:** a failing job doesn't stop other jobs or the worker
- **duplicates:** adding the same job twice runs it once; a job re-added for a finished deployment, or for a deleted one, is skipped
- **graceful shutdown:** `close()` lets the running job finish and leaves new jobs for the next worker

### Manual verification with Docker

```bash
docker compose up -d --build

# create a project, then 4 normal deployments and 1 that always fails
curl -s -X POST localhost:5000/api/projects -H "Content-Type: application/json" \
  -d '{"name":"demo","github_repo":"https://github.com/example/app"}'
curl -s -X POST localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'
curl -s -X POST localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" \
  -d '{"branch":"simulate/fail"}'

docker compose logs -f worker                          # watch jobs start, retry, complete
curl -s localhost:5000/api/projects/<projectId>/deployments   # statuses
curl -s localhost:5000/api/deployments/<deploymentId>/logs    # stored logs

# graceful shutdown: create a deployment, then stop the worker while it is BUILDING
docker compose stop worker                             # waits for the job, then "DeployX Worker stopped"
```

Polling 5 deployments like this (oldest first; Q = `QUEUED`, B = `BUILDING`, D = `DEPLOYING`, S = `SUCCESS`, F = `FAILED`) shows the concurrency limit and the retries of the failing deployment (the fifth):

```text
BBQQQ  DDQQQ  SSBBQ  SSDDQ  SSSSB  SSSSQ  SSSSB  SSSSQ  SSSSB  SSSSF
```

To try the API by hand, use the `curl` examples above against `http://localhost:5000`. Through the dashboard's proxy, `http://localhost:3000/api/...` works too.

## Troubleshooting

**PostgreSQL port not published on Windows.** Hyper-V/WSL reserves blocks of TCP ports, and the block can include 5432. When that happens, `docker compose ps` shows `5432/tcp` with no host mapping, and local tools get `ECONNREFUSED`. Check with:

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

If 5432 is inside one of the ranges, pick a free port in `.env`. Set both `POSTGRES_PORT` and the port in `DATABASE_URL`, for example `15432`, then run `docker compose up -d postgres`.

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
- [x] Worker with concurrency 2 and a clearly marked simulated pipeline
- [x] Status and logs written to PostgreSQL at every stage
- [x] 3 attempts with exponential backoff, final `FAILED` with a log
- [x] One failed job doesn't affect other jobs or the worker
- [x] Duplicate jobs are prevented; finished or deleted deployments are skipped
- [x] Graceful shutdown on `SIGTERM`/`SIGINT`
- [x] End-to-end tests (API → BullMQ → Redis → worker → PostgreSQL)
- [x] No Docker builds, git clones, AWS or webhooks (later phases)

## Future Phases

DeployX is developed incrementally across **8 phases**:

| Phase | Focus                                                                 |
| ----- | --------------------------------------------------------------------- |
| 1     | Project foundation ✅                                                 |
| 2     | Data model and REST API ✅                                            |
| **3** | **Job queue: BullMQ on Redis, worker job processing, retries, concurrency (this phase)** ✅ |
| 4     | Build & run: git clone, Docker build, container deployment            |
| 5     | Deployment history, state machine, real-time logs (WebSockets/SSE)    |
| 6     | Health checks for deployed apps, automatic rollback, stable versions  |
| 7     | GitHub OAuth & webhooks, AWS / EC2 cloud deployment                   |
| 8     | Production auth, security hardening, monitoring, CI/CD                |
