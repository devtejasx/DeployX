# DeployX

A self-service deployment platform: connect a GitHub repository, build it into a Docker image, deploy it, watch it run and roll back automatically when a release goes bad.

> **Status: Phase 2 of 8. Database and REST API.** DeployX is being built one phase at a time. The platform now stores projects, deployments and deployment logs, but it doesn't build or deploy anything yet. A deployment is only a database record until later phases add the build pipeline.

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
                │  services → db           │
                └──────┬────────────┬──────┘
                       │            │
                  SQL  │            │  PING
                       ▼            ▼
             ┌──────────────┐  ┌──────────┐
             │  PostgreSQL  │  │  Redis   │
             │    :5432     │  │  :6379   │
             └──────▲───────┘  └──────────┘
                    │ applies migrations, then exits
             ┌──────┴───────┐
             │   migrate    │  (one-shot job in Docker Compose)
             └──────────────┘

                ┌──────────────────────────┐
                │  worker  (Node.js)       │  starts and idles (jobs come in Phase 3)
                └──────────────────────────┘
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

## Tech Stack

| Layer          | Technology                                   |
| -------------- | -------------------------------------------- |
| Frontend       | React 19, Vite 8                             |
| Backend        | Node.js (≥ 20.12), Express 5                 |
| Validation     | zod 4                                        |
| Database       | PostgreSQL 17 (`pg` driver)                  |
| Migrations     | node-pg-migrate 9 (plain SQL files)          |
| Cache / queue  | Redis 7 (`redis` client)                     |
| Tests          | Node.js built-in test runner (`node:test`)   |
| Worker         | Node.js (no dependencies yet)                |
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
│   │   │   ├── redis.js
│   │   │   ├── migrate.js          # migration runner (CLI + programmatic)
│   │   │   └── migrations/         # versioned SQL
│   │   ├── app.js                  # Express app
│   │   └── server.js               # entry point: listen + graceful shutdown
│   ├── test/                       # integration tests (node:test)
│   └── Dockerfile
│
├── worker/                         # background worker (foundation only)
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
| `DATABASE_URL`      | `postgresql://deployx:deployx@localhost:5432/deployx`  | server, migrations (local) |
| `REDIS_URL`         | `redis://localhost:6379`                               | server (local)             |
| `DEV_USER_EMAIL`    | `dev@deployx.local`                                    | temporary current user     |
| `DEV_USER_NAME`     | `DeployX Developer`                                    | temporary current user     |
| `POSTGRES_USER`     | `deployx`                                              | postgres container         |
| `POSTGRES_PASSWORD` | `deployx`                                              | postgres container         |
| `POSTGRES_DB`       | `deployx`                                              | postgres container         |
| `POSTGRES_PORT`     | `5432`                                                 | host port for PostgreSQL   |
| `REDIS_PORT`        | `6379`                                                 | host port for Redis        |
| `TEST_DATABASE_URL` | `DATABASE_URL` + `_test`                               | integration tests only     |

Inside Docker Compose the API and the migrate job get `DATABASE_URL` and `REDIS_URL` pointing at the `postgres` and `redis` containers automatically.

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
npm run dev:worker
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
| `worker`   | `./worker`           | -         | starts and idles                                   |

```bash
docker compose ps -a              # service status (including the finished migrate job)
docker compose logs -f server     # follow API logs
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
| 503 | `/api/system/status` only: PostgreSQL or Redis unreachable |

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

These endpoints **only create and update records**. They don't clone, build or run anything.

**Create**: `POST /api/projects/:projectId/deployments` → `201`

| Field | Required | Rules |
| ----- | -------- | ----- |
| `commit_sha` | no | 7–40 hex characters (stored lower-case) |
| `branch` | no | valid git branch name; defaults to the project's `github_branch` |

`status` can't be set here. Every new deployment starts as `QUEUED`. Returns `404` if the project doesn't exist, and `409` if the project is `INACTIVE`.

```bash
curl -X POST http://localhost:5000/api/projects/<projectId>/deployments \
  -H "Content-Type: application/json" \
  -d '{ "commit_sha": "abc1234", "branch": "main" }'
```

```json
{
  "success": true,
  "data": {
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
  }
}
```

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

The integration tests start the real Express app on a random port and send HTTP requests to it. They run against a **separate test database**: `TEST_DATABASE_URL`, or your `DATABASE_URL` with `_test` appended (for example `deployx_test`). The tests create that database if needed, migrate it and empty it before each test file. Your development data is never touched.

```bash
npm run infra:up                  # PostgreSQL + Redis must be running
npm test                  # = npm --prefix server test
```

The suite (44 tests) covers:

- every endpoint with valid requests
- missing and invalid fields, read-only fields, and non-object bodies
- malformed and non-existent IDs for projects and deployments
- duplicate project names and deploying an inactive project
- invalid deployment statuses and log levels
- the schema itself: tables, indexes, foreign keys, CHECK constraints, and cascade on delete
- database failures, which must return a generic `500` without leaking internal details

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

## Future Phases

DeployX is developed incrementally across **8 phases**:

| Phase | Focus                                                                 |
| ----- | --------------------------------------------------------------------- |
| 1     | Project foundation ✅                                                 |
| **2** | **Data model and REST API (this phase)** ✅                           |
| 3     | Job queue: BullMQ on Redis, worker job processing, retries, concurrency |
| 4     | Build & run: git clone, Docker build, container deployment            |
| 5     | Deployment history, state machine, real-time logs (WebSockets/SSE)    |
| 6     | Health checks for deployed apps, automatic rollback, stable versions  |
| 7     | GitHub OAuth & webhooks, AWS / EC2 cloud deployment                   |
| 8     | Production auth, security hardening, monitoring, CI/CD                |
