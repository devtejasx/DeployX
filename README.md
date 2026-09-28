# DeployX

A self-service deployment platform: connect a GitHub repository, build it into a Docker image, deploy it, watch it run and roll back automatically when a release goes bad.

> **Status: Phase 4 of 8. Docker-based deployment.** DeployX is being built one phase at a time. Creating a deployment queues a job; the worker clones the public GitHub repository at the requested commit, builds a Docker image and starts it as a container on an isolated network, tracking everything in PostgreSQL. Health checks and rollback (Phase 6), real-time logs (Phase 5), GitHub/AWS integration (Phase 7) and production-grade isolation (Phase 8) come later. See [Security measures and limitations](#security-measures-and-limitations-development-setup) before deploying code you don't trust.

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
                       ▼         │ status+logs │ docker build / run (Docker socket)
             ┌──────────────┐    │             ▼
             │  PostgreSQL  │◀───┘   ┌────────────────────────────────────────┐
             │    :5432     │        │  Docker daemon                         │
             └──────▲───────┘        │   network "deployx-apps" (isolated)    │
                    │                │    └── app containers  127.0.0.1:<port>│
             ┌──────┴───────┐        └────────────────────────────────────────┘
             │   migrate    │  (one-shot job: applies migrations, then exits)
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
| `docker_image` | `varchar(255)` | image built for this deployment, e.g. `deployx/my-api-0f8fad5b:abc123def456` |
| `container_id`, `container_name` | `varchar` | the container started for this deployment |
| `host_port` | `integer` | host port (on 127.0.0.1) the container port is published on |
| `container_removed_at` | `timestamptz` | when the container was removed (e.g. replaced by a newer deployment) |
| `error_message` | `varchar(2000)` | short reason for a `FAILED` deployment |
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

| Migration | Adds |
| --------- | ---- |
| `1790330478769_create-core-schema` | `users`, `projects`, `deployments`, `deployment_logs`, indexes, triggers |
| `1790587019517_add-container-tracking` | `projects.container_port`; `deployments.container_id`, `container_name`, `host_port`, `container_removed_at`, `error_message` |

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
QUEUED ──▶ BUILDING ──────────────────────────────────▶ DEPLOYING ───────────────────────────▶ SUCCESS
            clone → checkout commit → check Dockerfile     docker run → still running after
            → docker build → image tagged                   CONTAINER_STARTUP_GRACE_MS →
                                                            previous container removed
   any failure in BUILDING or DEPLOYING ──▶ QUEUED (retry, if attempts remain) or FAILED
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

`curl http://127.0.0.1:10124/` then returns `Hello from DeployX`. The `HEALTH_CHECK` status is still unused. HTTP health checks come in Phase 6.

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

When a new deployment's container is running, the worker removes the project's **other** DeployX containers, found by the `deployx.project` label. It removes them only after the new container is confirmed running, so a failed deployment never takes the running version down. Replaced deployments stay in the history:
- their row and logs remain;
- `container_removed_at` is set;
- a log line says `Container removed: replaced by deployment <id>`.

This is not a rollback mechanism, which is Phase 6. If two deployments of the same project finish at nearly the same moment, the one that finishes last wins.

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

- Retries use the **existing BullMQ policy** from Phase 3: 3 attempts with 2 s and then 4 s backoff. There is no second retry mechanism. All attempts belong to the **same deployment record**; the logs show `Deployment job started (attempt 2 of 3)`.
- Failures that another attempt can't fix are raised as BullMQ `UnrecoverableError` and fail at once (`Deployment failed and will not be retried`). Build failures are retried, because many are transient (a registry timeout, `npm install` hitting the network).
- A container that exits is **removed**, and its last 30 output lines are stored as `[container] …` log lines. A deployment is only `SUCCESS` if Docker reports its container as running after the startup grace period.

### Workspace cleanup

- Each attempt starts from an **empty** `<WORKSPACE_ROOT>/<deployment-id>/` directory. The directory name is the deployment UUID and is checked, so it can't escape the workspace root.
- The workspace is removed at the end of every attempt, successful or not (`Cleanup completed: workspace removed`). If removal fails, a `WARN` log says so. It never changes the deployment's result.
- If a worker is killed mid-job, the next worker start removes workspaces older than an hour.
- **Images:** successful images are kept, since a later phase will roll back to them. A failed BuildKit build doesn't tag an image, so nothing half-built is left behind. Images of containers that failed to start are kept, and the container itself is removed. DeployX never prunes images in bulk.

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
  - `hello-app` answers `GET /` with `Hello from DeployX` on port 3000
  - `crash-app` exits immediately after starting
  - `broken-dockerfile` has an invalid instruction
- To use a repository of your own, it needs a Dockerfile and an app listening on a known port. Set `container_port` to that port.

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
│   ├── test/                       # integration, queue, unit and Docker e2e tests (node:test)
│   └── Dockerfile
│
├── worker/                         # deployment worker
│   ├── src/
│   │   ├── index.js                # entry point: start, SIGTERM/SIGINT shutdown
│   │   ├── worker.js               # BullMQ Worker, concurrency, event handlers
│   │   ├── processors/
│   │   │   └── deploymentProcessor.js  # job runner: idempotency, attempts, failure bookkeeping
│   │   ├── pipeline/
│   │   │   └── dockerDeployment.js     # clone → checkout → build → run → verify → replace
│   │   ├── services/
│   │   │   ├── deploymentService.js    # status + logs + container tracking in PostgreSQL
│   │   │   ├── gitService.js           # safe clone + exact commit checkout
│   │   │   ├── dockerService.js        # image/container naming, build, restricted run
│   │   │   └── workspace.js            # per-deployment workspace, path + Dockerfile checks
│   │   ├── lib/
│   │   │   ├── exec.js                 # spawn without a shell, env allowlist, timeouts
│   │   │   └── buildLog.js             # build output filtering and limits
│   │   ├── config/
│   │   │   ├── index.js            # environment configuration
│   │   │   └── redis.js            # ioredis connection factory
│   │   └── db/postgres.js
│   └── Dockerfile                  # adds git + Docker CLI (buildx)
│
├── examples/                       # test apps for deployments (hello-app, crash-app, broken-dockerfile)
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
| `APP_MEMORY_LIMIT` / `APP_CPU_LIMIT` | `512m` / `1`                       | worker: limits per app container |
| `WORKSPACE_ROOT`    | `<os temp>/deployx-workspaces`                      | worker: where repositories are cloned |
| `DOCKER_SOCKET_GID` | `0`                                                 | Compose: group owning the Docker socket |
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
| `worker`   | `./worker`           | -              | runs deployments; **the only service with the Docker socket**; 30 s stop grace period |

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
| `container_port` | **yes** | integer 1–65535: the port the app listens on inside its container |
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

**Get**: `GET /api/deployments/:deploymentId` → `200` with the same fields as the `deployment` in the create response. Once the worker has run, it shows the real outcome: resolved `commit_sha`, `docker_image`, `container_id`, `container_name`, `host_port`, `error_message` and timestamps (example in [Deployment lifecycle](#deployment-lifecycle)).

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
- short timings: the retry backoff is 200 ms, then 400 ms. The queue tests use a fast fake pipeline ([`fakePipeline.js`](server/test/fakePipeline.js)) instead of Docker.

```bash
npm run install:all       # the queue tests load the worker's dependencies too
npm run infra:up          # PostgreSQL + Redis must be running
npm test                  # = npm --prefix server test
```

The default suite (73 tests, about 20 s, no Docker or network needed) covers:

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
- **retries:** a job that always fails shows attempts 1, 2 and 3, then `FAILED`; a flaky one succeeds on attempt 3
- **isolation:** a failing job doesn't stop other jobs or the worker
- **duplicates:** adding the same job twice runs it once; a job re-added for a finished deployment, or for a deleted one, is skipped
- **graceful shutdown:** `close()` lets the running job finish and leaves new jobs for the next worker
- **worker units:** image/container naming, workspace isolation, Dockerfile checks (including symlinks), no shell interpretation of hostile arguments, secret-free child environments, clone arguments, build log limits

### Docker end-to-end tests

These tests run the **real pipeline**: they clone this repository from GitHub, build the [example apps](examples) with Docker and start containers. They need network access and a Docker daemon, so they're **opt-in**:

```bash
npm run test:docker       # 7 tests, about 1.5 min
```

| Test | Checks |
| ---- | ------ |
| 1. Successful build | commit `d577dab` → full SHA recorded, image `…:d577dab0332a`, container running, `GET /` = `Hello from DeployX`, log sequence, workspace removed |
| Security | container not privileged, no mounts, `CapDrop ALL`, `no-new-privileges`, limits set, only on the app network, ports on 127.0.0.1, no `DATABASE_URL`/`REDIS_URL`/passwords in its env, `postgres` not resolvable from the app network |
| 2 + 6. Invalid Dockerfile + retry | build fails → 3 attempts with 0.2 s / 0.4 s backoff → `FAILED`, parse error stored |
| 3. Missing Dockerfile | `Dockerfile not found at …`, no build, no retry |
| 4. Invalid commit | `Commit … not found on branch main`, no retry |
| 5. Container exits | image builds, container exits → output stored, container removed, `FAILED` after 3 attempts |
| 7. Multiple deployments | 3 deployments, 2 of them concurrent, all `SUCCESS`; exactly one container left; history kept with `container_removed_at` |

They use their own image prefix (`deployx-test/`) and network (`deployx-apps-test`), and they remove everything they created.

### Manual verification with Docker

Follow [Local setup and the test repository](#local-setup-and-the-test-repository) to deploy `hello-app`, then try the failing examples: `examples/crash-app/Dockerfile`, `examples/broken-dockerfile/Dockerfile`, a non-existent `dockerfile_path`, or a `commit_sha` that doesn't exist. Useful commands:

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

## Future Phases

DeployX is developed incrementally across **8 phases**:

| Phase | Focus                                                                 |
| ----- | --------------------------------------------------------------------- |
| 1     | Project foundation ✅                                                 |
| 2     | Data model and REST API ✅                                            |
| 3     | Job queue: BullMQ on Redis, worker job processing, retries, concurrency ✅ |
| **4** | **Build & run: git clone, Docker build, container deployment (this phase)** ✅ |
| 5     | Deployment history, state machine, real-time logs (WebSockets/SSE)    |
| 6     | Health checks for deployed apps, automatic rollback, stable versions  |
| 7     | GitHub OAuth & webhooks, AWS / EC2 cloud deployment                   |
| 8     | Production auth, security hardening, monitoring, CI/CD                |
