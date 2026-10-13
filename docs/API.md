# API reference

The REST API behind the dashboard. Every endpoint except the probes, `GET /api/system/status` and the GitHub webhook needs a signed-in session (the `deployx_session` cookie from `POST /api/auth/login`); state-changing requests from a browser must come from the dashboard's origin. See [Security](SECURITY.md) for authentication and roles, and [Deployment lifecycle](DEPLOYMENT_LIFECYCLE.md) for what happens after a deployment is queued.

## Response format

Every endpoint returns the same envelope.

```json
{ "success": true, "data": { } }
```

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Project not found" } }
```

Every error carries a stable `code` (Phase 8, see [API security](SECURITY.md#api-security)) and every response an `X-Request-Id` header.

Validation failures add `details`, with one readable message per problem:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": ["Project name is required", "GitHub repository URL is required"]
  }
}
```

| Code | When |
| ---- | ---- |
| 200 | success |
| 201 | resource created |
| 202 | GitHub webhook: deployments were queued |
| 400 | validation failed, malformed ID, or malformed JSON |
| 401 | not signed in, or the session expired; failed sign-in; GitHub webhook: signature missing or invalid |
| 403 | another user's project or deployment; an ADMIN-only endpoint; a cross-site request; registration disabled |
| 429 | rate limit exceeded (`Retry-After` says when to try again) |
| 404 | resource or route not found |
| 413 | request body too large (webhooks: over 5 MB) |
| 415 | a request body that is not JSON; GitHub webhook: not `application/json` |
| 409 | conflict: duplicate project name, deploying an inactive project, or an invalid deployment state transition (response includes `from` and `to`) |
| 500 | unexpected error; the response says `Internal server error`, and details go only to the server log |
| 503 | `/api/system/status`: PostgreSQL or Redis unreachable; creating a deployment: job queue unavailable; GitHub webhook: `GITHUB_WEBHOOK_SECRET` not configured |

Rules that apply to every endpoint:

- Every endpoint except the probes, `/metrics`, `/api/system/status`, `/api/auth/*` and the webhook requires a session cookie (`401` otherwise); a USER reaches only its own projects (`403` otherwise). With curl: `curl -c cookies.txt` on `/api/auth/login`, then `-b cookies.txt` on every request.
- IDs in the URL must be UUIDs. A malformed ID returns 400, and a well-formed ID that doesn't exist returns 404.
- Request bodies must be JSON objects. Unknown or read-only fields (`id`, `user_id`, `created_at`, `updated_at`, and so on) are rejected.
- All SQL is parameterized. User input is never concatenated into queries.

## Calling the API from the command line

The dashboard is the easiest client, and `npm run demo` drives the main path through the API for you. To call the API by hand, sign in once and keep the session cookie in a file. Put the credentials in a JSON file rather than on the command line, so the password stays out of your shell history:

```bash
# login.json: {"email": "admin@example.com", "password": "<your password>"}
curl -s -c cookies.txt -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" -d @login.json
curl -s -b cookies.txt http://localhost:5000/api/projects
```

Every example below sends `-b cookies.txt`. Requests without an `Origin` header (curl, scripts) are accepted; a browser request that changes something must come from the dashboard's origin. Sign-in is rate-limited (per account and per client address), so reuse the cookie instead of signing in for every call.

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/health`, `/api/health` | API liveness (no session) |
| GET | `/ready`, `/api/ready` | API readiness: PostgreSQL + Redis (no session) |
| GET | `/metrics` | Prometheus metrics (`METRICS_TOKEN`) |
| GET | `/api/system/status` | live PostgreSQL + Redis check (no session) |
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | accounts and sessions ([details](SECURITY.md#authentication)) |
| GET | `/api/auth/me` | the signed-in user |
| GET | `/api/monitoring/overview` | workers, queue, deployments, alerts ([details](OPERATIONS.md#deployment-monitoring-dashboard)) |
| GET | `/api/audit-logs` | audit log ([details](SECURITY.md#audit-log)) |
| POST | `/api/projects` | create a project |
| GET | `/api/projects` | list projects (newest first) |
| GET | `/api/projects/:id` | get one project |
| PUT | `/api/projects/:id` | update a project (partial) |
| DELETE | `/api/projects/:id` | delete a project, its deployments and their logs |
| POST | `/api/projects/:projectId/deployments` | create a deployment record (`QUEUED`) |
| GET | `/api/projects/:projectId/deployments` | list a project's deployments (newest first) |
| GET | `/api/deployments/:deploymentId` | get one deployment, including a project summary |
| PATCH | `/api/deployments/:deploymentId/status` | update deployment status (**ADMIN**) |
| POST | `/api/deployments/:deploymentId/logs` | add a log line (**ADMIN**) |
| GET | `/api/deployments/:deploymentId/logs` | list log lines (chronological) |
| GET | `/api/deployments/:deploymentId/logs/stream` | live logs and status as Server-Sent Events ([details](DEPLOYMENT_LIFECYCLE.md#real-time-deployment-logs)) |
| POST | `/api/webhooks/github` | GitHub push webhook, signature required ([details](DEPLOYMENT_LIFECYCLE.md#webhook-security)) |

## Health and status

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

## Projects

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
| `deployment_target` | no | `LOCAL` (default) or `AWS_ECS` |
| `aws_ecs_service` | with `AWS_ECS` | the project's ECS service: letters, digits, `-`, `_`; not used by another AWS project (`409`) |
| `aws_service_url` | with `AWS_ECS` | http(s) origin the service answers on, e.g. `https://my-app.example.com`; no credentials, path or query. Stored normalized (lower-case host, no trailing `/`) |
| `status` | no | `ACTIVE` (default) or `INACTIVE` |

```bash
curl -X POST -b cookies.txt http://localhost:5000/api/projects \
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
    "deployment_target": "LOCAL",
    "aws_ecs_service": null,
    "aws_service_url": null,
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
curl -X PUT -b cookies.txt http://localhost:5000/api/projects/<id> \
  -H "Content-Type: application/json" \
  -d '{ "description": "Updated", "status": "INACTIVE" }'
```

**Delete**: `DELETE /api/projects/:id` → `200`

```json
{ "success": true, "data": { "id": "9eac077c-992d-4e54-b682-b2f9ae11d48f", "deleted": true } }
```

## Deployments

Creating a deployment queues a background job (see [Deployment Jobs](ARCHITECTURE.md#deployment-jobs-bullmq)). The API itself never clones, builds or runs anything. The worker does, as described in [Docker Deployments](DEPLOYMENT_LIFECYCLE.md#docker-deployments).

**Create**: `POST /api/projects/:projectId/deployments` → `201` once the job is queued; the response does not wait for the job to run.

| Field | Required | Rules |
| ----- | -------- | ----- |
| `commit_sha` | no | 7–40 hex characters (stored lower-case) |
| `branch` | no | valid git branch name; defaults to the project's `github_branch` |

`status` can't be set here. Every new deployment starts as `QUEUED`. Returns `404` if the project doesn't exist, `409` if the project is `INACTIVE`, and `503` if the job queue (Redis) is unavailable. In the `503` case the deployment is recorded as `FAILED`.

```bash
curl -X POST -b cookies.txt http://localhost:5000/api/projects/<projectId>/deployments \
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
      "trigger": "MANUAL",
      "deployment_target": "LOCAL",
      "docker_image": null,
      "image_digest": null,
      "container_id": null,
      "container_name": null,
      "host_port": null,
      "container_removed_at": null,
      "aws_task_definition_arn": null,
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

**Get**: `GET /api/deployments/:deploymentId` → `200` with the same fields as the `deployment` in the create response. Once the worker has run, it shows the real outcome: resolved `commit_sha`, `docker_image`, `container_id`, `container_name`, `host_port`, `error_message` and timestamps (example in [Deployment lifecycle](DEPLOYMENT_LIFECYCLE.md#deployment-lifecycle)). `health_check` holds the recorded health-check details (see [Health checks and retries](DEPLOYMENT_LIFECYCLE.md#health-checks-and-retries)). `trigger` says whether it was created by hand or by a GitHub push; `deployment_target`, `image_digest` and `aws_task_definition_arn` identify where and as what it runs (see [Deployment records](DEPLOYMENT_LIFECYCLE.md#deployment-records)). For a deployment that failed its health check, `rollback_status` and `rollback_deployment_id` report what the automatic rollback did (see [Rollback](DEPLOYMENT_LIFECYCLE.md#rollback)); `is_stable` tells whether this is the project's last stable deployment.

**Update status**: `PATCH /api/deployments/:deploymentId/status` → `200` with the updated deployment

```bash
curl -X PATCH -b cookies.txt http://localhost:5000/api/deployments/<deploymentId>/status \
  -H "Content-Type: application/json" \
  -d '{ "status": "BUILDING" }'
```

Only `QUEUED`, `BUILDING`, `DEPLOYING`, `HEALTH_CHECK`, `ROLLING_BACK`, `SUCCESS`, `FAILED` and `ROLLBACK_FAILED` are accepted. Anything else returns `400`. The timestamps follow the status:

- `started_at` is set when work first begins (`BUILDING`), and kept if the deployment goes back to `QUEUED` for a retry. A deployment that fails straight from `QUEUED` has no `started_at`.
- `finished_at` is set on `SUCCESS`, `FAILED` or `ROLLBACK_FAILED` and cleared for any other status.

Only transitions allowed by the [state machine](DEPLOYMENT_LIFECYCLE.md#state-machine) are accepted. Anything else returns **409** with `from` and `to`; for example `DEPLOYING → SUCCESS`, which has to go through `HEALTH_CHECK`. Setting the current status again is a no-op (`200`).

Since Phase 3 the **worker** sets these statuses as it processes the job, so this endpoint is a manual override. It isn't coordinated with a job that is currently running, and the worker's next stage overwrites it. Setting `SUCCESS` or `FAILED` before the job starts makes the worker skip it.

## Deployment logs

**Add**: `POST /api/deployments/:deploymentId/logs` → `201`

| Field | Required | Rules |
| ----- | -------- | ----- |
| `level` | yes | `INFO`, `WARN` or `ERROR` |
| `message` | yes | 1–10000 characters, not blank; stored verbatim |

```bash
curl -X POST -b cookies.txt http://localhost:5000/api/deployments/<deploymentId>/logs \
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

**List**: `GET /api/deployments/:deploymentId/logs` → `200`, all log lines in the order they were written. For live output, use `GET /api/deployments/:deploymentId/logs/stream` (Server-Sent Events, see [Real-Time Deployment Logs](DEPLOYMENT_LIFECYCLE.md#real-time-deployment-logs)).
