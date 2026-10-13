# Deployment lifecycle

Every deployment, whether it comes from the dashboard, the API or a GitHub push, takes the same path: **queued → built from an exact commit → started on its target → health-checked → `SUCCESS`, or rolled back to the last stable version**. This document describes each stage, the state machine that enforces the order, live logs, and the two ways in (manual, GitHub push) and two targets (local Docker, AWS ECS).

> **AWS status:** the AWS ECR/ECS target is implemented and covered by automated tests against fake AWS endpoints, but it **has not been validated against real AWS infrastructure**. See [the Phase 9 validation report](PHASE9_VALIDATION.md).

## Docker deployments

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
   unhealthy in HEALTH_CHECK ──▶ ROLLING_BACK ──▶ FAILED or ROLLBACK_FAILED   (see Health checks below)
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

`curl http://127.0.0.1:10124/` then returns `Hello from DeployX`. The deployment only reaches `SUCCESS` through `HEALTH_CHECK` (see [Health checks and automatic rollback](#health-checks-and-automatic-rollback)).

### Git clone and commit checkout

[`gitService.js`](../worker/src/services/gitService.js) runs, without a shell:

```text
git clone --single-branch --branch <branch> --filter=blob:none --no-checkout -- <github_repo> <workspace>/source
git rev-parse --verify <commit_sha>^{commit}    # resolves abbreviated SHAs; must exist on that branch
git checkout --detach <full sha>
git rev-parse HEAD                              # verified to equal the resolved SHA
```

- **Exact commit, not "whatever the branch points at now".** If the deployment has a `commit_sha`, exactly that commit is built. A commit that isn't on the branch fails the deployment (`Commit … not found on branch main`). Without a `commit_sha`, the branch head is built and **its full SHA is written back to `commit_sha`**, so every deployment records exactly what it ran.
- **Public GitHub repositories only.** The worker re-checks the `https://github.com/<owner>/<repo>` format. Git prompts are disabled, and the machine's git config and credential helpers are ignored (`GIT_CONFIG_NOSYSTEM`, a throwaway `GIT_CONFIG_GLOBAL`, `credential.helper=`). A private or missing repository therefore fails with a clear message instead of hanging or using your stored GitHub token. Private repositories are cloned with a short-lived GitHub App token (see [Private repositories](#private-repositories-github-app)).
- Only the `https` transport is allowed (`protocol.allow=never`), and symlinks are checked out as plain files (`core.symlinks=false`).

### Dockerfile validation

The configured `dockerfile_path` must resolve **inside** the checked-out repository, and it must be a **regular file**. Symlinks and paths with `..` are refused. If it's missing, the deployment fails with `Dockerfile not found at <path>` and no build is started.

### Docker build and image naming

```text
docker build --progress=plain --file <workspace>/source/<dockerfile_path> --tag <image> \
             --label deployx.managed=true --label deployx.project=<id> --label deployx.deployment=<id> \
             -- <workspace>/source
```

- The **build context is the repository root**. A `<Dockerfile>.dockerignore` next to the Dockerfile (BuildKit) can shrink it. The [examples](../examples) use one.
- **Image name:** `deployx/<project-slug>-<first 8 chars of project id>:<first 12 chars of commit SHA>`, for example `deployx/hello-app-be9b5c8c:d577dab0332a`.
  - The slug is the project name, lower-cased, with anything other than `a-z0-9` replaced by `-` and cut to 40 characters.
  - The project-ID suffix keeps apart two projects whose names produce the same slug (`My API` and `my-api`).
  - The tag is always the commit, never `latest`.
  - Since Phase 6 every image gets a **second tag**, `…:deployment-<deployment-id>`. Building the same commit again moves the commit tag to the new image; the deployment tag keeps each deployment's own image on the Docker host, so a rollback can start it again.
- **Build logs are limited** ([`buildLog.js`](../worker/src/lib/buildLog.js)):
  - Only build steps (`#7 [2/4] RUN …`), errors and the final "naming to" line are stored, each once.
  - Each line is capped at 1000 characters, and each attempt at 150 lines (`BUILD_LOG_MAX_LINES`). A warning says how many lines were dropped.
  - Credentials in URLs are masked.
  - **On failure, the last lines of output are always stored**, so the error is visible even after the cap. The same lines stream live to the dashboard.
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
| Repository or branch missing / private | `BUILDING → FAILED` | no | `Repository … not found or not public (for a private repository, install the DeployX GitHub App on it)` / `Branch "x" not found in …` (Phase 7: private repositories work through a [GitHub App](#private-repositories-github-app)) |
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
| No shell anywhere: `git`/`docker` run via `spawn` with argument arrays; values are passed after `--` | [`exec.js`](../worker/src/lib/exec.js) |
| Child processes get an env **allowlist** (PATH, HOME, DOCKER_HOST …). `DATABASE_URL`, `REDIS_URL` and other secrets are never passed to `git`/`docker` | [`exec.js`](../worker/src/lib/exec.js) |
| Repo URL, branch, SHA and Dockerfile path are re-validated in the worker; paths can't leave the workspace; Dockerfile symlinks are refused | [`gitService.js`](../worker/src/services/gitService.js), [`workspace.js`](../worker/src/services/workspace.js) |
| Apps are **not privileged**: `--cap-drop ALL` + 8 common capabilities, `no-new-privileges`, 512 MB memory, 1 CPU, 256 processes, no volumes or bind mounts, no Docker socket, no DeployX env vars | [`dockerService.js`](../worker/src/services/dockerService.js) |
| Apps run on their own network with inter-container traffic off; app ports are bound to 127.0.0.1 | [`dockerService.js`](../worker/src/services/dockerService.js) |
| PostgreSQL, Redis, API and dashboard ports are published on 127.0.0.1 only; **Redis requires a password** | [`docker-compose.yml`](../docker-compose.yml) |

**Known limitations. Don't run untrusted code with this setup on a machine you care about.** What is hardened beyond this is listed in [Docker security](SECURITY.md#docker-security); the limitations below remain.

1. **The worker controls the host's Docker daemon.** In Docker Compose, `/var/run/docker.sock` is mounted into the **worker** (only the worker), and that's root-equivalent on the Docker host. It's needed to run `docker build`/`docker run`.
   - A filtering socket proxy (`tecnativa/docker-socket-proxy`) was tried. It blocks BuildKit's gRPC session, so builds fail.
   - Stronger options, not implemented: a rootless Docker/BuildKit daemon, a separate build host, or a sandboxed runtime such as gVisor or Kata.
2. **Builds run with the daemon's normal privileges.** `RUN` steps can use the network. Resource limits apply to the running app, not to the build, which is bounded only by its timeout.
3. **Docker Desktop's host IP.** On Docker Desktop, containers can reach the host's published ports through `host.docker.internal` / `192.168.65.254`, even when those ports are bound to 127.0.0.1. On plain Linux Docker, 127.0.0.1-bound ports are not reachable from containers.
   - So on Docker Desktop, a deployed app can reach PostgreSQL (password-protected), Redis (password-protected) and the API (which requires a signed-in session since Phase 8).
   - Change the default passwords in `.env` if others can deploy on your machine. See [Security](SECURITY.md) and the [production checklist](OPERATIONS.md#production-checklist).
4. **The API can't stop containers.** Deleting a project removes its database rows, but not its running container, because the API deliberately has no Docker access. Remove leftovers with:
   ```bash
   docker rm -f $(docker ps -aq --filter label=deployx.managed=true)
   ```
5. No build secrets and no per-project environment variables yet. Private repositories need the GitHub App.

### Local setup and the test repository

- **Test repository:** this repository itself. [`examples/`](../examples) holds the test apps:
  - `hello-app` answers `GET /` with `Hello from DeployX` and `GET /health` with `200`, on port 3000
  - `unhealthy-app` keeps running but answers `GET /health` with `503` (health-check failure and rollback)
  - `crash-app` exits immediately after starting
  - `broken-dockerfile` has an invalid instruction
- To use a repository of your own, it needs a Dockerfile and an app listening on a known port that answers a health-check request with a 2xx status. Set `container_port` to that port and, if the endpoint is not `/health`, `health_check_path` to its path.

```bash
docker compose up -d --build          # full stack, worker included (needs Docker Desktop / Docker Engine)
# Sign in first: the API needs a session (see API.md#calling-the-api-from-the-command-line)
# curl -s -c cookies.txt -X POST localhost:5000/api/auth/login -H "Content-Type: application/json" -d @login.json

curl -s -X POST -b cookies.txt localhost:5000/api/projects -H "Content-Type: application/json" -d '{
  "name": "hello-app",
  "github_repo": "https://github.com/devtejasx/DeployX",
  "dockerfile_path": "examples/hello-app/Dockerfile",
  "container_port": 3000
}'
curl -s -X POST -b cookies.txt localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'
curl -s -b cookies.txt localhost:5000/api/deployments/<deploymentId>         # status, image, container, host_port
curl -s -b cookies.txt localhost:5000/api/deployments/<deploymentId>/logs    # clone, build and run logs
curl -s http://127.0.0.1:<host_port>/                         # Hello from DeployX
```

Running the worker outside Docker (`npm run dev:worker`) works the same way, using your local `git` and `docker` CLIs. On Linux, give Compose the socket's group: `DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)` in `.env`.

## Deployment state machine

> **The current transition map is in [Health checks → State machine](#state-machine)**: it adds `HEALTH_CHECK`, `ROLLING_BACK` and the final `ROLLBACK_FAILED` to the original map below and removes `DEPLOYING → SUCCESS`. This section describes how the machine is built and enforced.

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
| (`HEALTH_CHECK`) | reserved in Phase 5; in use since Phase 6 | see [the current map](#state-machine) |

`BUILDING/DEPLOYING → QUEUED` is kept on purpose. Since Phase 3, a failed attempt waits in `QUEUED` until BullMQ retries it; every attempt stays on the same deployment row. Everything else is rejected, for example `SUCCESS → BUILDING`, `FAILED → DEPLOYING` and `SUCCESS → QUEUED`.

**Where it's enforced.** The API and the worker are separate packages. The only place both can share one definition is the **database**. Migration [`1790671094193_deployment-state-machine`](../server/src/db/migrations/1790671094193_deployment-state-machine.sql) adds three things:

- **`deployment_status_transitions`**: the map above, as rows with descriptions. Phase 6 extended it with migrations that insert and delete rows; no code changed to enforce the new edges.
- a **trigger** on `deployments` that rejects any status change not in the table, with SQLSTATE `DX001` and detail `{"from","to"}`. It applies to every writer: the API, the worker, or plain SQL.
- **`transition_deployment_status(id, status, error_message)`**, the one function that changes status:
  1. It locks the row and reads the current status.
  2. It returns nothing for an unknown deployment.
  3. It's a **no-op** if the status is already the target, so repeating a step is harmless.
  4. Otherwise it applies the change and keeps the timestamps right: `started_at` when work first begins (kept across retries), `finished_at` on `SUCCESS`/`FAILED`, and `error_message` on `FAILED`.

In code, both sides call a `transitionDeploymentStatus(deploymentId, newStatus)` wrapper. No code writes `deployments.status` directly.

- **API:** [`deploymentStateMachine.js`](../server/src/services/deploymentStateMachine.js). `PATCH /api/deployments/:id/status` returns **409** for an invalid transition:
  ```json
  { "success": false, "error": { "message": "Invalid deployment state transition", "from": "SUCCESS", "to": "BUILDING" } }
  ```
- **Worker:** `transitionDeploymentStatus()` in [`deploymentService.js`](../worker/src/services/deploymentService.js). It still writes the status and its log line in one statement. An invalid transition ends the job as an `UnrecoverableError`, without retries; for example, when someone sets a running deployment to `FAILED` by hand.

## Real-time deployment logs

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

## Health checks and automatic rollback

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

- **`SUCCESS` is only reachable from `HEALTH_CHECK`.** Migration [`1790767291227`](../server/src/db/migrations/1790767291227_health-check-required-and-image-id.sql) deletes the `DEPLOYING → SUCCESS` row, so "never successful before the health check" is a database rule for the worker, the API and plain SQL alike.
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
curl -X PUT -b cookies.txt localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" \
  -d '{ "health_check_path": "/api/status" }'
```

Nothing is hard-coded in the pipeline: the path comes from the project, the rest from the worker's configuration ([`config/index.js`](../worker/src/config/index.js)).

### Health-check target

The check goes to **`<HEALTH_CHECK_HOST>:<host_port>`**, the port Docker published for the container, not to `<container name>:<container port>`. That follows from how Phase 4 runs apps:

- Apps run on the `deployx-apps` network with inter-container traffic disabled, and the worker is deliberately not on that network. A container name is therefore neither resolvable nor reachable from the worker.
- Every app's `container_port` is published on `127.0.0.1:<random port>` of the Docker host and recorded as `host_port`. That is the one address through which anything outside the container reaches it, so it is also what a health check should exercise.
- A worker running on the host (`npm run dev:worker`) uses `127.0.0.1`. A worker inside Docker Compose is a container itself, where `127.0.0.1` is the worker; it reaches the host's published ports as `host.docker.internal`, which Compose sets as `HEALTH_CHECK_HOST`.
- When a rollback re-checks a stable container, the port is read from Docker (`docker container inspect`), not from the database: a container that was restarted by hand gets a new host port.

### Health checks and retries

[`healthCheckService.js`](../worker/src/services/healthCheckService.js) has two functions:

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

[`rollbackService.js`](../worker/src/services/rollbackService.js), called by [`pipeline/release.js`](../worker/src/pipeline/release.js):

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

`npm run demo` runs this scenario through the API and checks every outcome; the [demo guide](DEMO_GUIDE.md) walks through it in the dashboard. By hand:

```bash
docker compose up -d --build
# Sign in first: the API needs a session (see API.md#calling-the-api-from-the-command-line)
# curl -s -c cookies.txt -X POST localhost:5000/api/auth/login -H "Content-Type: application/json" -d @login.json

# 1. A healthy version: becomes SUCCESS and stable
curl -s -X POST -b cookies.txt localhost:5000/api/projects -H "Content-Type: application/json" -d '{
  "name": "rollback-demo",
  "github_repo": "https://github.com/devtejasx/DeployX",
  "dockerfile_path": "examples/hello-app/Dockerfile",
  "container_port": 3000
}'
curl -s -X POST -b cookies.txt localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'

# 2. An unhealthy version of the same project: unhealthy-app answers GET /health with 503
curl -s -X PUT -b cookies.txt localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" \
  -d '{ "dockerfile_path": "examples/unhealthy-app/Dockerfile" }'
curl -s -X POST -b cookies.txt localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'

# 3. The second deployment is FAILED with rollback_status COMPLETED; the first is still live
curl -s -b cookies.txt localhost:5000/api/projects/<projectId>/deployments
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

## GitHub integration and AWS deployment

A push to GitHub now deploys by itself, and a deployment can run on **Amazon ECS** instead of the worker's Docker host. Neither is a second system. The webhook only **creates a deployment and queues it**, exactly as `POST /api/projects/:id/deployments` does. AWS is a **deployment target** that the same worker pipeline, health check, state machine, rollback and live log stream use.

```text
Developer pushes code
        ↓
GitHub ── push webhook, signed with the shared secret ──▶ DeployX API  POST /api/webhooks/github
                                                              ↓ verify signature → parse → repository → branch → commit
                                                          PostgreSQL   deployment QUEUED, trigger GITHUB_PUSH, exact commit SHA
                                                              ↓
Manual deployment (dashboard / API) ─────────────────▶   BullMQ / Redis   the same "deployments" queue, job ID = deployment ID
                                                              ↓
                                                          Worker
                                                              ↓ git clone + checkout <sha>   (GitHub App token for private repositories)
                                                          Docker build   deployx/<project>-<id>:<sha12>
                                                              ↓
                                        ┌───────────── LOCAL ─┴─ AWS_ECS ──────────────────┐
                                        ↓                                                  ↓
                                   docker run                          ECR login, push  <project>-<id>-<sha12>  → digest
                                        ↓                                                  ↓
                                        │                              ECS: new task definition revision running
                                        │                                   <repository>@<digest> → UpdateService → rollout
                                        └──────────────────────┬───────────────────────────┘
                                                               ↓
                                                         HEALTH_CHECK  (Phase 6: container port, or the ECS service URL)
                                                      ┌────────┴────────┐
                                                   healthy          unhealthy
                                                      ↓                  ↓
                                                   SUCCESS          ROLLING_BACK ── stable version restored
                                                   (stable)              ↓          (on AWS: its image digest, no rebuild)
                                                                    HEALTH_CHECK of the stable version
                                                                   ┌─────┴──────┐
                                                                   ↓            ↓
                                                           FAILED (recovered)  ROLLBACK_FAILED
```

### Repository configuration

A project's repository is its `github_repo` and its deployed branch is `github_branch`, both already present since Phase 2. They can be edited in the dashboard (**Settings** on an application) or with `PUT /api/projects/:id`:

```bash
curl -X PUT -b cookies.txt localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" \
  -d '{ "github_repo": "https://github.com/octo-org/storefront", "github_branch": "main" }'
```

The repository owner and name (`octo-org`, `storefront`) are derived from the URL wherever they are needed: webhook matching, GitHub App tokens, the dashboard.

### Webhook configuration

On GitHub: **Repository → Settings → Webhooks → Add webhook** (or the webhook of a GitHub App, see [Private repositories](#private-repositories-github-app)):

| Field | Value |
| ----- | ----- |
| Payload URL | `https://<your DeployX host>/api/webhooks/github` |
| Content type | **`application/json`** (form-encoded deliveries are refused with `415`) |
| Secret | the same random value as the API's `GITHUB_WEBHOOK_SECRET` |
| Events | **Just the push event** |

```bash
# A secret for GITHUB_WEBHOOK_SECRET (and for GitHub)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

GitHub sends a `ping` first, and DeployX answers it with `200`. The webhook is **disabled** (`503`) while `GITHUB_WEBHOOK_SECRET` is empty, so an unconfigured server never processes unsigned pushes.

**Local development.** GitHub cannot reach `localhost`. Forward the deliveries with a tunnel, for example `npx smee-client --url https://smee.io/<channel> --target http://localhost:5000/api/webhooks/github` or `cloudflared tunnel --url http://localhost:5000`, and use the tunnel's URL as the Payload URL. The dashboard's **Settings** panel shows the path and the expected settings; it never shows the secret.

### Webhook security

A delivery is handled in this order. Nothing in the payload is read before the signature has been verified:

| Step | Refused with |
| ---- | ------------ |
| 1. `GITHUB_WEBHOOK_SECRET` configured | `503 GitHub webhooks are not configured on this server` |
| 2. `X-Hub-Signature-256` present | `401 Missing X-Hub-Signature-256 header` |
| 3. `sha256=` + HMAC-SHA256 of the **raw body** with the secret, compared with `crypto.timingSafeEqual` | `401 Invalid webhook signature` |
| 4. `X-GitHub-Event` present | `400 Missing X-GitHub-Event header` |
| 5. `Content-Type: application/json` | `415` |
| 6. body is JSON | `400 Malformed JSON payload` |
| 7. event is `push` (`ping` answers `200`) | `400 Unsupported GitHub event "issues": only push events are handled` |
| 8. push payload valid: `ref`, 40-hex `after`, `repository.html_url`, a valid branch name | `400 Invalid push payload` with the reasons |
| 9. repository is used by a project | `404 No DeployX project uses repository octo-org/unknown` |

- The raw body is kept for the signature: the webhook route is mounted **before** the JSON parser, with its own 5 MB limit (`413` above it).
- The secret, the signature and the request headers are never logged or returned. The API logs one line per push: `[webhook] push to octo-org/storefront@main 65ea1cf (delivery …): 1 queued, 0 duplicate, 0 ignored`.
- The webhook is not behind the development user: it acts for the **repository** and is authenticated by its signature. It can only create deployments of projects already connected to that repository, on their configured branch.
- Commit messages go into the logs as one line with control characters removed and at most 120 characters.

### Branch deployments and exact commits

For a push to `refs/heads/<branch>` of a repository, **every project using that repository** is looked at on its own:

| Project | Result |
| ------- | ------ |
| `github_branch` is the pushed branch, `ACTIVE` | deployment created and queued (`202`) |
| another `github_branch` | ignored: `Project deploys branch main, not development` |
| `INACTIVE` | ignored: `Project is inactive` |

Tag pushes (`refs/tags/…`) and branch deletions are ignored with `200`. A push that deploys nothing also answers `200`, with the reasons in `ignored`, so GitHub shows a successful delivery:

```json
{
  "success": true,
  "data": {
    "event": "push",
    "delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "repository": "octo-org/storefront",
    "branch": "main",
    "commit_sha": "65ea1cf20982350219c481ae50b96be383266c2f",
    "deployments": [{ "project_id": "842dbc87-…", "deployment_id": "09f8e403-…", "duplicate": false }],
    "ignored": [],
    "message": "1 deployment queued"
  }
}
```

**The deployment is pinned to the commit GitHub sent** (`after`, the full 40-character SHA), never to the moving branch head: a newer push to the same branch cannot change what an earlier deployment builds. The database requires it: a `GITHUB_PUSH` deployment without a full SHA is rejected by a CHECK constraint. The worker checks out exactly that commit, and a retry of the job builds the same commit again. A manual deployment without `commit_sha` still resolves the branch head once, when it is built, and records that SHA as before.

### Duplicate deliveries

A delivery can arrive more than once: redelivered from the webhook's **Recent Deliveries** page or through GitHub's API, or sent by both a repository webhook and a GitHub App. A partial unique index allows **one push deployment per project and commit**. The insert uses `ON CONFLICT DO NOTHING`, so even simultaneous deliveries of the same push create exactly one deployment, one job and one set of log lines. A duplicate answers `200` with the existing deployment:

```json
{ "deployments": [{ "project_id": "…", "deployment_id": "09f8e403-…", "duplicate": true }], "message": "Already deployed: this commit was received before" }
```

Manual deployments are not affected: redeploying any commit by hand is always possible. BullMQ's own duplicate protection (job ID = deployment ID, since Phase 3) still applies underneath.

### Private repositories (GitHub App)

Public repositories need nothing. For private ones the worker uses a **GitHub App**:

| Option | Why (not) |
| ------ | --------- |
| **GitHub App** ✔ | installed per repository or organisation, the worker gets a token for **one repository, `contents: read`, expiring within an hour**; no user account or long-lived token involved; its webhook can deliver the pushes too |
| OAuth App | acts as a signed-in user with that user's access; needs a user login flow, which comes with authentication in Phase 8 |
| Personal access token | long-lived, tied to a person, usually broader than one repository |
| Deploy key | SSH; the worker only allows `https` for git (Phase 4 hardening), and every repository needs its own key |

Setup: create a GitHub App (**Settings → Developer settings → GitHub Apps**) with **Repository permissions → Contents: Read-only** (and, to use its webhook, the **Push** event with the URL and secret above), install it on the repositories, and give the worker `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the `.pem`, with `\n` for line breaks in `.env`).

For each deployment the worker:

1. signs a 9-minute JWT for the App with its private key (RS256, `node:crypto`)
2. asks GitHub whether the App is installed on the repository (`GET /repos/{owner}/{repo}/installation`); if not, it clones anonymously as before
3. creates an installation token limited to that repository and `contents: read`
4. hands it to git as an `Authorization` header for `https://github.com/` only, through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` in git's environment

The token is never in git's command line (visible to other processes), the remote URL, `.git/config`, the database, a log line or the API. It is not sent to any other host, even on a redirect. Credential helpers stay disabled. The API and the browser never see the App's key. Log line: `Using a GitHub App token for octo-org/storefront (read-only, expires 2026-10-01T11:00:00Z)`. Wrong App credentials (GitHub answers `401`) fail the deployment at once; GitHub outages and rate limits are retried like any network error.

### Docker image versioning

Every image is named after its commit, and every deployment records an identifier that cannot move:

| | Local (`LOCAL`) | ECR (`AWS_ECS`) |
| - | --------------- | --------------- |
| commit tag | `deployx/my-api-0f8fad5b:abc123def456` | `<registry>/deployx-apps:my-api-0f8fad5b-abc123def456` |
| deployment tag | `deployx/my-api-0f8fad5b:deployment-<id>` | `<registry>/deployx-apps:my-api-0f8fad5b-deployment-<id>` |
| immutable identity | image ID `sha256:…` (`docker_image_id`) | manifest digest `sha256:…` (`image_digest`) |
| what runs | the local image ID | `<registry>/deployx-apps@sha256:…` |

`<project>-<first 8 of the project ID>` keeps projects apart even when their names sanitize the same. The commit tag tells which commit an image is, but it can move when the same commit is built again. The digest cannot move, so **ECS always runs, and a rollback always restores, the exact image that was built and checked**. The deployment tag keeps every deployment's image referenced, so an ECR lifecycle rule that removes untagged images does not remove an older stable version. `latest` is never used.

### ECR setup

One ECR repository holds the images of all AWS projects. DeployX reads its URI from ECR, so no account ID has to be configured:

```bash
aws ecr create-repository --repository-name deployx-apps --image-scanning-configuration scanOnPush=true
```

Keep **tag mutability `MUTABLE`**: rebuilding a commit moves its commit tag (what runs is pinned by digest anyway). For each deployment the worker calls `GetAuthorizationToken`, logs Docker in with `docker login --password-stdin` (the password is never an argument), tags the local image and pushes both tags. It then reads the digest from ECR (`DescribeImages`), not from the push output. Logs: `Logging in to Amazon ECR` → `ECR login succeeded` → `Pushing image to ECR as …` → `Image pushed to ECR: … (digest sha256:…)`.

### AWS deployment architecture

**Amazon ECS on Fargate** (or EC2 capacity) with ECR, not EKS or Kubernetes: DeployX already produces one container image per deployment, and an ECS service with a load balancer is the smallest managed platform that runs one, replaces it with a rolling update and reports its progress. **DeployX does not create infrastructure.** The operator sets up once:

1. an ECS **cluster** (`AWS_ECS_CLUSTER`)
2. per project, a **task definition** whose app container maps the project's `container_port`, and a **service** (networking, load balancer, IAM roles, CPU/memory, desired count), preferably with the deployment circuit breaker enabled
3. the project in DeployX: target `AWS_ECS`, `aws_ecs_service`, and `aws_service_url` = the URL the service answers on (its load balancer or domain)

```bash
curl -X PUT -b cookies.txt localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" -d '{
  "deployment_target": "AWS_ECS",
  "aws_ecs_service": "storefront",
  "aws_service_url": "https://storefront.example.com"
}'
```

A deployment then changes **only the image** ([`awsDeploymentService.js`](../worker/src/services/awsDeploymentService.js)):

```text
DescribeServices         the service, and the task definition it runs now
DescribeTaskDefinition   that task definition (with its tags)
RegisterTaskDefinition   a new revision: identical, except the app container's image = <repository>@<digest>
                         (the app container: the only one, or the one mapping container_port; sidecars untouched)
UpdateService            the service rolls over to the new revision
DescribeServices …       every AWS_ECS_POLL_INTERVAL_MS until the ECS deployment is COMPLETED,
                         FAILED (e.g. the circuit breaker) or AWS_ECS_DEPLOY_TIMEOUT_MS passes
```

All AWS calls of the worker are in [`ecrService.js`](../worker/src/services/ecrService.js) and [`awsDeploymentService.js`](../worker/src/services/awsDeploymentService.js). The target [`awsEcsTarget.js`](../worker/src/targets/awsEcsTarget.js) puts them in order. The worker pipeline itself contains no AWS code.

**IAM permissions of the worker** (replace `<…>`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": ["ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage",
                 "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
      "Resource": "arn:aws:ecr:<region>:<account>:repository/deployx-apps"
    },
    { "Effect": "Allow", "Action": ["ecs:DescribeServices", "ecs:UpdateService"], "Resource": "arn:aws:ecs:<region>:<account>:service/<cluster>/*" },
    { "Effect": "Allow", "Action": ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:TagResource"], "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": ["arn:aws:iam::<account>:role/<task execution role>", "arn:aws:iam::<account>:role/<task role>"],
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    }
  ]
}
```

**Credentials are never configured in DeployX or stored in PostgreSQL.** The AWS SDK uses its default chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` or `AWS_PROFILE` in the worker's environment, or preferably the IAM role of the machine or task the worker runs on. Child processes (git, docker build) do not inherit them (the Phase 4 environment allow-list), so a build cannot read them.

### Deployment targets

```text
Pipeline (pipeline/dockerDeployment.js)          one for every deployment
  build.js                  clone → checkout → Dockerfile → docker build           (same for both)
  target.publish            LOCAL: nothing          AWS_ECS: ECR login + push → digest
  target.deploy             LOCAL: docker run       AWS_ECS: task definition revision → UpdateService → rollout
  release.js                HEALTH_CHECK → SUCCESS | rollbackService.js            (same for both)
    target.healthCheck      LOCAL: 127.0.0.1:<host_port>    AWS_ECS: aws_service_url
    target.restoreStable    LOCAL: stable container / image ID    AWS_ECS: stable digest → rollout
```

| | `LOCAL` | `AWS_ECS` |
| - | ------- | --------- |
| runs as | a container on the worker's Docker host | the project's ECS service |
| health check | `http://127.0.0.1:<host_port><health_check_path>` | `<aws_service_url><health_check_path>` (http or https) |
| identity recorded | `container_id`, `container_name`, `host_port`, `docker_image_id` | `image_digest`, `aws_task_definition_arn`, `docker_image` = ECR reference |
| deployments of one project | side by side; promotion and rollback serialized | one at a time (the service is one live slot): the per-project lock covers rollout, health check and promotion/rollback |
| previous version during the health check | keeps running in its container | replaced by the rolling update; the rollback deploys it again |

A deployment records its target when it is created and is deployed, and rolled back, there even if the project is switched meanwhile. A rollback only uses a stable deployment **of the same target**. After switching a project from `LOCAL` to `AWS_ECS`, the first unhealthy AWS deployment has nothing to roll back to on AWS and says so: `No previous stable deployment on AWS_ECS available for rollback (the last stable deployment ran on LOCAL).` The first successful AWS deployment retires the project's local container. Local Docker deployments are unchanged and remain the default.

### Health checks on AWS

`DEPLOYING` ends when the ECS rollout completed. The deployment then goes through the Phase 6 health check (same attempts, interval, timeout, grace period and `health_check` details), requesting `GET <aws_service_url><health_check_path>`. Only a healthy answer leads to `SUCCESS`.

The host now comes from the project, so the worker makes sure the check cannot be used to reach internal systems:

- `aws_service_url` must be an http(s) **origin**: no credentials, path, query or fragment. The API, a database CHECK and the worker each enforce this.
- The host is resolved once. **Every** address it resolves to must be allowed, and the request is pinned to the checked address, so a DNS answer that changes in between (rebinding) cannot redirect it. HTTPS still verifies the certificate for the host name.
- **Never allowed:** link-local addresses, including the instance metadata service (`169.254.169.254`, `fd00:ec2::254`), and unspecified, multicast and reserved ones. **Private and loopback addresses** (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `100.64/10`, `fc00::/7`, `::1`) are refused unless `HEALTH_CHECK_ALLOW_PRIVATE_URLS=true`, which is meant for internal load balancers when the worker runs in the same VPC.
- Redirects are not followed, as before.

### Rollback on AWS

The Phase 6 [`rollbackService.js`](../worker/src/services/rollbackService.js) is still the only rollback, with the same statuses, outcomes and log lines. Only the infrastructure step differs:

```text
b91d2e7 unhealthy → ROLLING_BACK → stable deployment a81f4c2 (same project, same target)
   → is its digest still in ECR?  ── no ──▶ ROLLBACK_FAILED  "image … is no longer available in ECR"
   → new task definition revision with <repository>@<a81f4c2's digest> → UpdateService → rollout
   → HEALTH_CHECK of the stable version ── unhealthy ──▶ ROLLBACK_FAILED
   → healthy → b91d2e7 FAILED, rollback COMPLETED; a81f4c2 stays the stable deployment
```

**Nothing is rebuilt**: the stable version returns from the exact image it was built and checked as. The stable deployment's record keeps its history; only `aws_task_definition_arn` is updated to the revision it now runs in (the AWS counterpart of recording its new container locally). Without a stable deployment on AWS (`NOT_AVAILABLE`), the service is pointed back at the task definition it ran before this deployment. ECS finishes that rollback on its own.

### Deployment records

`GET /api/deployments/:id` now also returns:

```json
{
  "trigger": "GITHUB_PUSH",
  "deployment_target": "AWS_ECS",
  "commit_sha": "65ea1cf20982350219c481ae50b96be383266c2f",
  "docker_image": "123456789012.dkr.ecr.eu-west-1.amazonaws.com/deployx-apps:storefront-842dbc87-65ea1cf20982",
  "image_digest": "sha256:18e0f01a505b4e4242ddb50dc4bfcd541a670ef5238de05f811c13855383a84a",
  "aws_task_definition_arn": "arn:aws:ecs:eu-west-1:123456789012:task-definition/storefront:8",
  "container_id": null
}
```

The job payload in Redis is unchanged: identifiers only, no repository credentials, tokens or AWS settings.

### Logs

Every step is a log line in PostgreSQL, published over Redis Pub/Sub and streamed to the dashboard over SSE, through the same Phase 5 pipeline. A push deployment to AWS (the format as asserted by the end-to-end test; IDs shortened):

```text
INFO  GitHub webhook received: push to main (delivery 72d3162e-…)
INFO  Repository identified: octo-org/storefront, deploying branch main
INFO  Commit identified: 65ea1cf20982350219c481ae50b96be383266c2f (Add checkout page)
INFO  Deployment created
INFO  Deployment job started (attempt 1 of 3)
INFO  Deployment is now building                                                        status BUILDING
INFO  Using a GitHub App token for octo-org/storefront (read-only, expires …)          private repositories only
INFO  Cloning repository https://github.com/octo-org/storefront (branch main)
INFO  Checking out commit 65ea1cf20982350219c481ae50b96be383266c2f
INFO  Docker image created: deployx/storefront-842dbc87:65ea1cf20982
INFO  Logging in to Amazon ECR (repository deployx-apps)
INFO  ECR login succeeded
INFO  Pushing image to ECR as storefront-842dbc87-65ea1cf20982
INFO  Image pushed to ECR: 123456789012.dkr.ecr.eu-west-1.amazonaws.com/deployx-apps:storefront-842dbc87-65ea1cf20982 (digest sha256:18e0…)
INFO  Deployment is now deploying                                                       status DEPLOYING
INFO  AWS deployment started: ECS service storefront in cluster deployx
INFO  Registered task definition storefront:8 (container app)
INFO  ECS deployment ecs-svc/4271503921374856018 started; waiting for the new tasks
INFO  AWS deployment progressing: 0/2 tasks running, 2 pending
INFO  AWS deployment progressing: 2/2 tasks running, 0 pending
INFO  ECS rollout completed: 2/2 tasks running
INFO  AWS deployment completed: ECS service storefront runs storefront:8
INFO  Running health checks: GET https://storefront.example.com/health (up to 5 attempts, 2s timeout, 2s apart)   status HEALTH_CHECK
INFO  Health check attempt 1/5 passed: HTTP 200 in 84ms
INFO  Deployment completed successfully                                                 status SUCCESS
```

A rollback on AWS adds `The unhealthy version is replaced on ECS service storefront`, `Starting stable version from image … (digest 18e0f01a505b)`, the rollout lines, `Running health check on the stable version`, `Stable version is healthy` and `Rollback completed successfully: deployment … is live`. No secret appears in any of them: not the webhook secret, the signature, the GitHub token, the ECR password or AWS credentials.

### Failure handling

| Situation | Result |
| --------- | ------ |
| Webhook without or with a wrong signature, malformed, unsupported, unknown repository | refused (`401`/`400`/`415`/`404`), nothing is created |
| Push to another branch, a tag, a deleted branch, an inactive project | ignored (`200`), nothing is created |
| Redelivered push | `200`, the existing deployment; nothing new |
| Redis unavailable when the webhook queues | `503`; that deployment is recorded `FAILED` (Phase 3 rule), and a manual deployment redeploys the commit |
| GitHub API unavailable / rate-limited (token) | the attempt fails and is retried (BullMQ backoff) |
| GitHub App credentials wrong | `FAILED` at once, `…check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY` |
| Private repository without the App | `FAILED`, `Repository … not found or not public (for a private repository, install the DeployX GitHub App on it)` |
| `docker build` fails | unchanged (Phase 4): retried, then `FAILED` |
| ECR push fails (network, throttling) | retried; the ECR repository missing, access denied or no credentials: `FAILED` at once, e.g. `ECR GetAuthorizationToken failed: AccessDeniedException: …` |
| ECS rollout fails (tasks do not start, circuit breaker) or times out | the service is pointed back at its previous task definition, the attempt is retried, then `FAILED` with `ECS rollout failed: …` / `ECS deployment did not complete within 600s (…)`. The version never ran, so there is no health check and no rollback |
| ECS service or cluster missing, container port not in the task definition, permissions missing | `FAILED` at once with the reason |
| AWS settings missing on the worker | `FAILED` at once: `AWS deployments are not configured on this worker: set AWS_REGION, …` |
| Unhealthy after deployment | Phase 6 rollback: `FAILED` (restored) / `ROLLBACK_FAILED` (stable image gone from ECR, rollout failed, or stable version unhealthy too) / `NOT_AVAILABLE` |
| Worker crash, PostgreSQL outage | unchanged (Phase 6): an interrupted attempt starts again from `QUEUED`; an interrupted rollback ends `ROLLBACK_FAILED`; nothing becomes `SUCCESS` without a recorded health check |

### Concurrency and isolation

Projects are independent. Each has its own ECS service (a unique index prevents sharing one), its own image tags (`<project>-<id>-…`), its own deployments, BullMQ jobs (job ID = deployment ID) and Redis channels (`<prefix>:deployment:<id>:events`). A rollback only ever looks at the project's own stable deployment, on the same target. Deployments of **one** AWS project are serialized by the per-project PostgreSQL lock, so two pushes never update the same service at once. Local deployments keep the Phase 6 behaviour. The end-to-end tests deploy three AWS projects at once and check all of this.

### Security summary

- Webhooks: HMAC-SHA256 over the raw body, constant-time comparison, refused while no secret is configured, payload validated after verification, 5 MB limit.
- No secret in source code, `.env.example`, the database, Redis job payloads, logs, API responses or the browser. `GITHUB_WEBHOOK_SECRET` is in the API only; the GitHub App key and AWS credentials are in the worker only.
- No shell anywhere: git and docker run with argument arrays. Repository URLs, branch names, commit SHAs, service names and URLs are validated by the API, the database and again by the worker. The ECR password goes through stdin, and the GitHub token through git's environment, scoped to `https://github.com/`.
- Health checks on AWS cannot reach metadata or (by default) private addresses, and cannot be redirected.
- AWS changes are limited to one repository and the project's own service; DeployX never creates or deletes AWS resources.
