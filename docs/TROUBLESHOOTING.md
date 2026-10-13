# Troubleshooting

Symptoms, their usual cause, and the fix: setting up first, then deployments, then running DeployX for others.

## Setup and local development

**`docker compose up` fails with `failed to connect to the docker API` / `Cannot connect to the Docker daemon`.** Docker Desktop (or the Docker Engine service) is not running. Start it, wait until `docker version` shows a Server section, and run the command again.

**PostgreSQL port not published on Windows.** Hyper-V/WSL reserves blocks of TCP ports, and the block can include 5432. When that happens, `docker compose ps` shows `5432/tcp` with no host mapping, and local tools get `ECONNREFUSED`. Check with:

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

If 5432 is inside one of the ranges, pick a free port in `.env`. Set both `POSTGRES_PORT` and the port in `DATABASE_URL`, for example `15432`, then run `docker compose up -d postgres`.

**Worker says `docker is not usable` / `permission denied … docker.sock`.** In Docker Compose, set `DOCKER_SOCKET_GID` to the group that owns the socket (`stat -c %g /var/run/docker.sock` on Linux; `0` on Docker Desktop). Outside Docker, make sure `docker version` works in the shell that starts `npm run dev:worker`.

**`NOAUTH Authentication required` from Redis.** Redis requires a password. Make `REDIS_URL` in `.env` include `REDIS_PASSWORD`: `redis://:<password>@localhost:6379`.

**The dashboard says `Could not reach the API`.** The API is down or still starting. `docker compose ps` should show `server` as `healthy`; `docker compose logs server` shows why it is not (for example a database it cannot reach). The `migrate` service must have exited with code 0 first.

**`401 Authentication required` from `curl`.** Every API call except the probes, `/api/system/status` and the webhook needs a session. Sign in with `-c cookies.txt` and send `-b cookies.txt` (see [Calling the API from the command line](API.md#calling-the-api-from-the-command-line)).

**Cannot sign in: `Invalid email or password`, or `429` after several tries.** Sign-in answers the same for a wrong password and an unknown account. Set a password with `npm run user:create -- --email <you> --role ADMIN` (it updates an existing account). Failed sign-ins are limited per account (5) and per client address (10) per 15 minutes; wait, or restart Redis in development.

**`npm run demo` fails.** It prints the step and the reason, and exits 1:
- `Set DEMO_EMAIL and DEMO_PASSWORD`: create the account first (see [Quick start](LOCAL_SETUP.md#quick-start-docker-compose)) and export both variables.
- `POST /api/auth/login answered 401`: wrong credentials; `fetch failed`: the API is not on `DEPLOYX_API_URL` (default `http://localhost:5000`).
- `Expected SUCCESS, got FAILED`: open the printed deployment in the dashboard; the log says which step failed (a clone needs network access to GitHub).
- `The healthy version does not answer on its port`: the script reaches apps on `127.0.0.1`; set `DEMO_APP_HOST` if the worker publishes ports elsewhere.

## Deployments, GitHub and AWS

**Deployment fails with `Health check failed after 5 attempts`.** The container runs, but the health check did not get a 2xx answer. The attempt lines in the logs say why:
- `Health check returned HTTP 404`: the app has no `/health` endpoint. Add one, or set the project's `health_check_path` to a path that answers 200 (`PUT /api/projects/:id` with `{"health_check_path": "/"}`).
- `Connection refused` or `Connection closed before a response was received`: nothing listens on `container_port` inside the container, or the app only listens on `127.0.0.1` instead of `0.0.0.0`.
- `Health check timed out`: the app needs longer to start or to answer. Raise `HEALTH_CHECK_STARTUP_GRACE_MS`, `HEALTH_CHECK_RETRIES` or `HEALTH_CHECK_TIMEOUT_MS`.
- Every deployment fails with `Connection refused` when the worker runs in Docker Compose on Linux: the worker container can't reach ports bound to the host's `127.0.0.1`. Run the worker on the host (`npm run dev:worker`).

**Deployment fails with `Project has no container_port configured`.** Projects created before Phase 4 have no port. Set it with `PUT /api/projects/:id` and `{"container_port": 3000}`.

**GitHub shows failed webhook deliveries.** Open the delivery under **Recent Deliveries**; the response body says why:
- `401 Invalid webhook signature`: the webhook's secret differs from `GITHUB_WEBHOOK_SECRET` (or a proxy changed the body). `401 Missing X-Hub-Signature-256 header`: no secret is set on GitHub.
- `503 GitHub webhooks are not configured on this server`: set `GITHUB_WEBHOOK_SECRET` for the API and restart it.
- `415`: set the webhook's content type to `application/json`.
- `400 Unsupported GitHub event "…"`: subscribe only to push events. A GitHub App also receives `installation` events, which show as failed deliveries and can be ignored.
- `404 No DeployX project uses repository …`: the project's `github_repo` must be this repository.
- `200` with `ignored`: the push was to a branch no project deploys, or the project is inactive. `200` with `duplicate: true`: that commit was already deployed by push; deploy it again by hand if needed.

**Private repository: `not found or not public`.** Install the DeployX GitHub App on the repository (Contents: read-only) and set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for the worker. The worker logs at startup whether an App is configured.

**AWS deployment fails.**
- `AWS deployments are not configured on this worker`: set `AWS_REGION`, `AWS_ECR_REPOSITORY` and `AWS_ECS_CLUSTER` for the worker (the startup log says which are missing).
- `… failed: CredentialsProviderError` / `AccessDeniedException`: the worker has no AWS credentials or lacks a permission from the [IAM policy](DEPLOYMENT_LIFECYCLE.md#aws-deployment-architecture).
- `ECS service … was not found in cluster …`: create the service, or fix `aws_ecs_service`.
- `Task definition … has no container for port …`: the project's `container_port` must be the port the app container maps.
- `ECS rollout failed: …` / `ECS deployment did not complete within …`: the new tasks did not start or become healthy on ECS. Look at the service's events and the tasks' stopped reasons and logs in the AWS console (DeployX does not read CloudWatch).
- `Health check failed … resolves to the private address …`: the service URL points into a private network; if the worker can reach it there, set `HEALTH_CHECK_ALLOW_PRIVATE_URLS=true`.

## Running DeployX for others

| Symptom | Cause / fix |
| ------- | ----------- |
| Dashboard shows the sign-in form after an upgrade | expected: sign in, or give the old development user a password with `user:create` |
| `403 Registration is disabled` | production default; create accounts with `npm run user:create` |
| `403 CROSS_ORIGIN_REQUEST` | the dashboard's origin is not in `CLIENT_URL` (behind a proxy, also check the `Host` header it forwards) |
| `429 RATE_LIMITED` in development | raise the `RATE_LIMIT_*` values; failed sign-ins lock the address for 15 minutes |
| API exits at start with `unsafe_configuration` | `NODE_ENV=production` with development settings: the log lists each one |
| `/ready` is `503` | the response says which: `postgres`, `redis` or `shutdown` |
| Monitoring says "No worker is running" | no heartbeat in Redis: the worker is down, cannot reach Redis, or uses a different `QUEUE_PREFIX` |
| `/metrics` returns `404` in production | set `METRICS_TOKEN` and send it as a bearer token |
| A deployment ended *Deployment timed out after …* | it exceeded `DEPLOYMENT_TIMEOUT_MS` (or a step's own limit); the log says where |
| *Deployment marked FAILED by the recovery check* | its job disappeared from Redis (data loss, manual removal); deploy again |
| AWS deployment fails with `AccessDeniedException` | the worker's IAM role lacks one of the [listed actions](SECURITY.md#aws-security-least-privilege); it is not retried |
| Every client shares one rate limit; the audit log shows one proxy address for everybody | `TRUST_PROXY` is not set behind nginx or a load balancer: set it to the number of proxies |
| Deployed apps are `Exited` after the Docker host restarted, but show `SUCCESS` | `LOCAL` apps are not restarted automatically; redeploy each project's stable commit (see [below](#known-issues-found-in-the-phase-9-validation)) |
| `docker compose ps` shows the worker `unhealthy` | an old `docker-compose.yml` whose healthcheck used `localhost` (fixed in Phase 9); update and run `docker compose up -d` |
| GitHub lists a delivery as failed (timeout) | GitHub waits 10 s; the API may have been down or slow. Redeliver it from the webhook's settings: duplicates are ignored |

## Known issues found in the Phase 9 validation

- **Deployed `LOCAL` apps do not survive a Docker host restart.** They run with `--restart no` (on purpose: a crashing app must fail its deployment, not restart in a loop) on ephemeral host ports. After a restart DeployX itself comes back, but the apps stay `Exited` while their deployments still read `SUCCESS`. `docker start` revives them on **new** ports (rollbacks still work, as they read the live port from Docker). **Recover by redeploying each project's stable commit.** On AWS ECS the service scheduler replaces stopped tasks.
- **Reverting the Phase 8 migration** (`migrate:down`) drops roles, password hashes, sessions and the audit log. Recover from a bad migration with the backup taken before it.
- GitHub waits 10 s per delivery. A delivery GitHub reports as failed can still have reached DeployX through a proxy that held the connection. Redeliver it: duplicates are ignored.
