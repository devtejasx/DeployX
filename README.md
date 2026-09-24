# DeployX

A self-service deployment platform: connect a GitHub repository, build it into a Docker image, deploy it, watch it run and roll back automatically when a release goes bad.

> **Status: Phase 1 of 8. This is the project foundation.** DeployX is being built one phase at a time. The platform doesn't deploy anything yet. It sets up the stack that later phases build on.

## Overview

Phase 1 sets up the base of the platform:

- A **React dashboard** that shows the live health of the system
- An **Express API** with health and system-status endpoints
- **PostgreSQL** and **Redis**, with verified connections from the API
- A **worker** process that later phases will use for background deployment jobs
- **Docker Compose**, which runs the whole stack with one command

## Architecture

```text
                ┌──────────────────────────┐
  Browser ────▶ │  client  (React + Vite)  │  :3000
                └────────────┬─────────────┘
                             │  /api/*  (dev proxy)
                             ▼
                ┌──────────────────────────┐
                │  server  (Express API)   │  :5000
                └──────┬────────────┬──────┘
                       │            │
            SELECT 1   │            │  PING
                       ▼            ▼
             ┌──────────────┐  ┌──────────┐
             │  PostgreSQL  │  │  Redis   │
             │    :5432     │  │  :6379   │
             └──────────────┘  └──────────┘

                ┌──────────────────────────┐
                │  worker  (Node.js)       │  starts and idles in Phase 1
                └──────────────────────────┘
```

The browser only talks to the client. The Vite dev server forwards `/api/*` requests to the API, so the frontend never contains a hard-coded backend URL. The API checks PostgreSQL and Redis live on every `GET /api/system/status` request. The dashboard shows exactly what the API reports.

## Tech Stack

| Layer          | Technology                                   |
| -------------- | -------------------------------------------- |
| Frontend       | React 19, Vite 8                             |
| Backend        | Node.js (≥ 20.12), Express 5                 |
| Database       | PostgreSQL 17 (`pg` driver)                  |
| Cache / queue  | Redis 7 (`redis` client)                     |
| Worker         | Node.js (no dependencies yet)                |
| Local infra    | Docker, Docker Compose                       |

## Project Structure

```text
DeployX/
├── client/                    # React dashboard (Vite)
│   ├── public/                # static assets (favicon)
│   ├── src/
│   │   ├── api/               # API calls (systemApi.js)
│   │   ├── components/        # UI components (StatusRow)
│   │   ├── hooks/             # useSystemStatus - fetch + auto-refresh
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js         # dev server on :3000, /api proxy
│   ├── Dockerfile
│   └── package.json
│
├── server/                    # Express API
│   ├── src/
│   │   ├── config/            # environment configuration
│   │   ├── controllers/       # request handlers
│   │   ├── routes/            # route definitions
│   │   ├── middleware/        # 404 + global error handler
│   │   ├── services/          # system status checks
│   │   ├── db/                # PostgreSQL pool, Redis client
│   │   ├── app.js             # Express app (no network listen)
│   │   └── server.js          # entry point: listen + graceful shutdown
│   ├── Dockerfile
│   └── package.json
│
├── worker/                    # background worker (foundation only)
│   ├── src/index.js
│   ├── Dockerfile
│   └── package.json
│
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json               # convenience scripts for the whole repo
└── README.md
```

## Prerequisites

- **Node.js 20.12 or newer** (22 LTS recommended) and npm
- **Docker** with the Compose plugin (Docker Desktop on Windows/macOS)
- **Git**

## Environment Variables

Copy the template and adjust if needed:

```bash
cp .env.example .env
```

`.env` is git-ignored. Only `.env.example` is committed, and it contains only local development defaults.

| Variable            | Default                                                | Used by                    |
| ------------------- | ------------------------------------------------------ | -------------------------- |
| `NODE_ENV`          | `development`                                          | server, worker             |
| `PORT`              | `5000`                                                 | server (also host port)    |
| `CLIENT_URL`        | `http://localhost:3000`                                | server (CORS origin)       |
| `DATABASE_URL`      | `postgresql://deployx:deployx@localhost:5432/deployx`  | server (when run locally)  |
| `REDIS_URL`         | `redis://localhost:6379`                               | server (when run locally)  |
| `POSTGRES_USER`     | `deployx`                                              | postgres container         |
| `POSTGRES_PASSWORD` | `deployx`                                              | postgres container         |
| `POSTGRES_DB`       | `deployx`                                              | postgres container         |
| `POSTGRES_PORT`     | `5432`                                                 | host port for PostgreSQL   |
| `REDIS_PORT`        | `6379`                                                 | host port for Redis        |

Inside Docker Compose the API gets `DATABASE_URL` and `REDIS_URL` pointing at the `postgres` and `redis` containers automatically. The `localhost` values are only for running the API directly on your machine.

## Local Development

Run the infrastructure in Docker and the apps on your machine, with hot reload:

```bash
# 1. Configure
cp .env.example .env

# 2. Install dependencies for client, server and worker
npm run install:all

# 3. Start PostgreSQL and Redis
npm run infra:up          # = docker compose up -d postgres redis

# 4. In separate terminals
npm run dev:server        # API on http://localhost:5000 (node --watch)
npm run dev:client        # dashboard on http://localhost:3000
npm run dev:worker        # prints "DeployX Worker started"
```

Open <http://localhost:3000>.

## Running with Docker Compose

Run the whole stack in containers:

```bash
cp .env.example .env      # optional - Compose falls back to the same defaults
docker compose up --build
```

| Service    | Image / build        | Host port | Notes                                         |
| ---------- | -------------------- | --------- | --------------------------------------------- |
| `postgres` | `postgres:17-alpine` | 5432      | data in the `postgres-data` volume, healthcheck |
| `redis`    | `redis:7-alpine`     | 6379      | data in the `redis-data` volume, healthcheck  |
| `server`   | `./server`           | 5000      | starts after postgres + redis are healthy     |
| `client`   | `./client`           | 3000      | Vite dev server, proxies `/api` to `server`   |
| `worker`   | `./worker`           | -         | starts and idles                              |

Useful commands:

```bash
docker compose ps                 # service status
docker compose logs -f server     # follow API logs
docker compose down               # stop everything (keeps data volumes)
docker compose down -v            # stop and delete the database/redis volumes
```

Images aren't rebuilt when you edit code. After a change, run `docker compose up --build` again, or use the local development workflow above for hot reload.

## API Endpoints

### `GET /api/health`

Checks that the API process is up. It doesn't touch the database or Redis.

```json
{ "status": "ok", "service": "deployx-api", "timestamp": "2026-09-24T09:00:47.791Z" }
```

### `GET /api/system/status`

Live connectivity check of every dependency (`SELECT 1` on PostgreSQL, `PING` on Redis, each with a 3 s timeout).

**200 OK**: everything is reachable:

```json
{
  "api": "connected",
  "database": "connected",
  "redis": "connected",
  "checkedAt": "2026-09-24T08:58:01.244Z"
}
```

**503 Service Unavailable**: at least one dependency is down. The body still reports every service, plus the reason:

```json
{
  "api": "connected",
  "database": "connected",
  "redis": "disconnected",
  "checkedAt": "2026-09-24T08:58:03.381Z",
  "errors": { "redis": "Redis client is not connected" }
}
```

### Errors

| Code | When                                               |
| ---- | -------------------------------------------------- |
| 400  | malformed JSON request body                        |
| 404  | unknown route: `{"error":{"message":"Route not found: GET /api/x","statusCode":404}}` |
| 500  | unexpected server error (global error handler)     |
| 503  | a dependency (PostgreSQL/Redis) is unreachable     |

## Phase 1 Status

- [x] React dashboard showing live API / database / Redis status
- [x] Express API with `/api/health` and `/api/system/status`
- [x] PostgreSQL connection module (connectivity only, no schema)
- [x] Redis connection module (connectivity only, auto-reconnect)
- [x] Worker foundation that starts and shuts down cleanly
- [x] 404 handling and global error handler
- [x] Docker Compose for the full stack
- [x] Environment-based configuration, secrets kept out of git

## Future Phases

DeployX is developed incrementally across **8 phases**:

| Phase | Focus                                                                 |
| ----- | --------------------------------------------------------------------- |
| **1** | **Project foundation (this phase)**                                   |
| 2     | Data model: users, projects, deployments, deployment logs, CRUD APIs  |
| 3     | Job queue: BullMQ on Redis, worker job processing, retries, concurrency |
| 4     | Build & run: git clone, Docker build, container deployment            |
| 5     | Deployment history, state machine, real-time logs (WebSockets/SSE)    |
| 6     | Health checks for deployed apps, automatic rollback, stable versions  |
| 7     | GitHub OAuth & webhooks, AWS / EC2 cloud deployment                   |
| 8     | Production auth, security hardening, monitoring, CI/CD                |
