# Development history

DeployX was built in nine phases, each delivered as a series of commits straight to `main`, followed by a tenth phase for documentation, usability and the demo. The README and the topic documents describe the system as it is; this page keeps what each phase added and the per-phase checklists.

## What each phase added

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
- Test apps in [`examples/`](../examples) and opt-in **Docker end-to-end tests**

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

**Phase 7 (GitHub integration and AWS deployment)**

- **`POST /api/webhooks/github`**: GitHub push webhooks, **HMAC-SHA256 signature verified** (constant time) before anything else is read; a push to a project's branch creates a deployment of **that exact commit** through the same queue, worker and pipeline as a manual deployment
- **Duplicate protection**: a redelivered push never creates a second deployment (one push deployment per project and commit, enforced by a unique index)
- **Private repositories** through a **GitHub App**: a read-only token for the one repository, created per deployment and passed to git outside its arguments, config and logs
- **Deployment targets**: `LOCAL` (a container on the worker's Docker host, as before) or **`AWS_ECS`**: image pushed to **ECR** by commit tag, run on the project's **ECS/Fargate service by digest**, health-checked on the service URL, **rolled back by digest** through the Phase 6 rollback
- Deployment records name their **trigger** (`MANUAL` / `GITHUB_PUSH`), **target**, **image digest** and **ECS task definition**
- Dashboard **Settings** for repository, branch and target; history shows trigger and target; details show commit link, image version, digest and task definition

**Phase 8 (production security and monitoring)**

- **Accounts and sessions**: scrypt-hashed passwords, server-side sessions in an HttpOnly, SameSite=Strict cookie; `npm run user:create` for administrators
- **Authorization**: ADMIN and USER roles; another user's project, deployment, logs or settings answer **403**; operator endpoints are ADMIN-only
- **Hardened API**: Helmet security headers, CORS allow-list, cross-site request checks, JSON-only bodies, stable error codes, request IDs, **rate limits** in Redis, a production configuration check
- **Reliability**: a timeout for every deployment, recovery of deployments whose job was lost, statement and AWS call timeouts, graceful shutdown, `docker run --pull never`
- **Observability**: structured JSON logs with secrets redacted, **Prometheus metrics** for the API and workers, `/health` and `/ready`, worker heartbeats, a **monitoring panel** with alerts, Prometheus alert rules, an **audit log**

**Phase 9 (production validation)**

- No new architecture: the whole system was run against real GitHub webhooks, real Docker deployments and rollbacks, injected outages, 78 live security checks and a backup/restore; four defects were fixed. Real AWS was not run. See the [validation report](PHASE9_VALIDATION.md).

**Phase 10 (documentation, usability and demo)**

- The phase-ordered README became a short overview plus topic documents in `docs/`, checked against the code (stale schema, curl examples without a session, an outdated audit result corrected)
- Dashboard: create applications, edit the Dockerfile path, port and health-check path, one time format, clearer empty states, a history table that fits
- `npm run demo`: a repeatable healthy → unhealthy → rollback demo through the API, and genuine screenshots captured from the running stack

## Phase 7 audit: what existed and what was added

| Area | Already there (Phases 1–6) | Added in Phase 7 |
| ---- | -------------------------- | ---------------- |
| Repository | `projects.github_repo` (canonical `https://github.com/<owner>/<repo>`), `github_branch`; exact-commit checkout | nothing new in the schema: owner and name are read from `github_repo`, so they are not stored twice |
| Authentication | none; public repositories only, git credential helpers disabled | GitHub App installation tokens for private repositories (worker only) |
| Webhook | none | `POST /api/webhooks/github`: signature, push parsing, project and branch matching, idempotency |
| Pipeline | one Docker pipeline, release and rollback wired to Docker | a deployment-target interface with the Phase 4–6 Docker code as `LOCAL` and a new `AWS_ECS` target; one pipeline, one release, one rollback |
| Images | `deployx/<project>-<id>:<sha12>` + `:deployment-<id>`, local image ID | ECR tags `<project>-<id>-<sha12>` + `…-deployment-<id>`, registry **digest** |
| Records | commit, image, container, health check, rollback | `trigger`, `deployment_target`, `image_digest`, `aws_task_definition_arn` |

## Not in Phase 7

Deliberately left for Phase 8 or later: user authentication and OAuth sign-in (still the development user), per-user GitHub/AWS accounts, reading task logs from CloudWatch, creating AWS infrastructure, other GitHub events (pull requests, releases), multi-region, autoscaling, monitoring and Kubernetes.

**Known limitations.** On `ROLLBACK_FAILED` the ECS service may still run the unhealthy version (when the stable image was missing) or the unhealthy stable revision. The status exists to say that someone has to look. Several projects on one repository and branch are handled in one webhook request; if the queue fails midway, the ones already created stay queued and the response is `503`.

## Phase 8 audit: what existed and what changed

| Area | Before Phase 8 | Phase 8 |
| ---- | -------------- | ------- |
| Authentication | none: every request was one development user (`devUser` middleware) | email + password (scrypt), server-side sessions in an HttpOnly, SameSite=Strict cookie; `devUser` removed |
| Authorization | queries scoped by `user_id`; another user's project answered 404 | ADMIN / USER roles; another user's project or deployment answers **403**; operator endpoints ADMIN-only |
| API security | zod validation, UUID params, parameterized SQL | + Helmet headers, CORS allow-list with credentials, cross-site request check, JSON-only bodies (415), 100 KB limit, stable error codes, request IDs, `TRUST_PROXY` |
| Rate limiting | none | per IP / user / account, counted in Redis, memory fallback |
| Secrets | `.env` ignored; webhook secret API-only, GitHub App key and AWS credentials worker-only; child env allow-list | + log redaction, startup check that refuses development defaults in production, `METRICS_TOKEN`, committed-secret scan in the tests |
| Webhooks | HMAC-SHA256, constant time, verified before parsing | unchanged, plus rate limit, audit entry and metrics |
| Docker | no shell, cap-drop ALL, no-new-privileges, limits, isolated network | + `docker run --pull never`; DeployX's own Compose services drop all capabilities |
| AWS | least-privilege policy, default credential chain, permanent errors final | + connection/request timeouts and SDK retries on every call |
| SSRF | health checks pinned to resolved, allowed addresses | re-audited: metadata, link-local, private, loopback and DNS-rebinding cases covered by the regression suite |
| Database | parameterized queries, FKs, CHECKs, state-machine trigger | + users/sessions/audit tables, statement timeouts, two monitoring indexes |
| Redis / BullMQ | password, 127.0.0.1, offline queue off on the API | + AOF persistence, `noeviction`, recovery of deployments whose job was lost |
| Timeouts | per step (git, build, run, health, ECS) | + `DEPLOYMENT_TIMEOUT_MS` for a whole attempt, AWS SDK timeouts, PostgreSQL statement timeouts |
| Monitoring | `/api/health`, `/api/system/status` | `/health`, `/ready`, Prometheus `/metrics` (API and worker), worker heartbeats, monitoring overview + dashboard panel, alert rules |
| Logging | ad-hoc `console` lines | structured JSON with request, deployment, project and job IDs; secrets redacted |
| Tests | 274 regular + 11 Docker, no frontend tests | 378 regular + 11 Docker (security, reliability, monitoring, shutdown suites added) + 22 frontend tests |

## Phase 9: production validation

Phase 9 added no architecture. It ran the system from Phases 1–8 in a real environment, broke it on purpose, and recorded the results. The full report, with every deployment ID, commit, image, timing and check, is **[docs/PHASE9_VALIDATION.md](PHASE9_VALIDATION.md)**.

```text
GitHub ─ push ─▶ Webhook (HMAC) ─▶ API ─▶ PostgreSQL (source of truth)
                                    │
                                    ▼
                             BullMQ / Redis ─▶ Worker ─▶ git clone ─▶ Docker build
                                                           │
                                     ┌─────────────────────┴──────────────────────┐
                                  LOCAL: docker run                  AWS_ECS: ECR push ─▶ ECS service
                                     └─────────────────────┬──────────────────────┘
                                                           ▼
                                        Health check ─▶ SUCCESS (stable)
                                              │
                                              └─ unhealthy ─▶ Rollback to the last stable version
                                                                ─▶ FAILED, or ROLLBACK_FAILED
            Every status and log line ─▶ PostgreSQL + Redis Pub/Sub ─▶ SSE ─▶ dashboard
```

### Result

| Area | Result |
| ---- | ------ |
| Real GitHub webhook (ping, unknown repository, wrong branch, correct branch, duplicate delivery, invalid signature) | **PASS**: deliveries sent by GitHub itself |
| Real deployment: push → webhook → queue → worker → build → container → health check → `SUCCESS` | **PASS**: 12.85 s from creation, 19 s from `git push` |
| Automatic rollback (A stable, B unhealthy) | **PASS**: A answered 190/190 requests during B's deployment and rollback |
| First deployment failure (`NOT_AVAILABLE`), rollback failure (`ROLLBACK_FAILED`) | **PASS**: no impossible rollback, no false `SUCCESS` |
| Concurrency (3 projects pushed at once) | **PASS**: 0 isolation problems |
| Injected failures (GitHub, webhook delivery, PostgreSQL, Redis, worker crash, build, start-up, health-check timeout) | **PASS**: every case ends in a meaningful state |
| SSE: live statuses, client disconnect, proxy restart in a real browser | **PASS**: 0 lost, 0 duplicated lines |
| Security (78 live checks), secrets scan of the whole history | **PASS** |
| Monitoring, backup/restore (history deleted and restored identically) | **PASS** |
| Tests | **413/413**: 380 API/worker/integration/security, 11 Docker, 22 frontend; frontend build passes |
| **Real AWS (ECR, ECS, health check and rollback on AWS)** | **NOT RUN**: no AWS account; verified only against fakes |

**Release: NOT READY.** The release checklist requires a real AWS deployment, which has never been run, so no `v1.0.0` tag was created. To complete it, follow [Repeating the validation](PHASE9_VALIDATION.md#repeating-the-validation) with an AWS account.

**State machine:** a failed health check runs `HEALTH_CHECK → ROLLING_BACK → FAILED` (or `ROLLBACK_FAILED`), not `FAILED → ROLLING_BACK`. `FAILED` is final and ends the live stream, and the stable version's health check is logged inside `ROLLING_BACK` (unchanged since Phase 6).

### Defects found and fixed

- The Compose **worker was always `unhealthy`**: its healthcheck used `localhost`, which is `::1` only in the Alpine image, while the worker listens on IPv4. It now uses `127.0.0.1`.
- During a **Redis outage** the worker printed raw stack traces outside the JSON logs (a BullMQ queue without an `error` listener). They now go through the logger as `recovery_queue_error`.
- A **paused** stable container gave the rollback reason *no published port* (Docker hides ports while paused). It now says *the stable container is paused*.
- `.env.example` lacked 8 variables the code reads. They were added.

### Limitations found in Phase 9

- **Deployed `LOCAL` apps do not survive a Docker host restart.** They run with `--restart no` (on purpose: a crashing app must fail its deployment, not restart in a loop) on ephemeral host ports. After a restart DeployX itself comes back, but the apps stay `Exited` while their deployments still read `SUCCESS`. `docker start` revives them on **new** ports (rollbacks still work, as they read the live port from Docker). **Recover by redeploying each project's stable commit.** On AWS ECS the service scheduler replaces stopped tasks.
- **Reverting the Phase 8 migration** (`migrate:down`) drops roles, password hashes, sessions and the audit log. Recover from a bad migration with the backup taken before it.
- GitHub waits 10 s per delivery. A delivery GitHub reports as failed can still have reached DeployX through a proxy that held the connection. Redeliver it: duplicates are ignored.

## Phase checklists

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

**Phase 7: GitHub integration and AWS deployment**

- [x] Existing Phase 1–6 functionality still works: all earlier tests and the 11 Docker end-to-end tests pass
- [x] GitHub repository and branch configurable (API and dashboard); owner and name derived, not duplicated
- [x] `POST /api/webhooks/github` with HMAC-SHA256 signature verification (constant time) before any parsing
- [x] Push events only; the configured branch is deployed, others ignored; the exact commit SHA is extracted and pinned
- [x] Duplicate deliveries handled by a unique index (race-safe)
- [x] A push creates a deployment through the same `queueDeployment()`, BullMQ queue, worker and pipeline as a manual one
- [x] Existing Docker build unchanged; images tagged by commit, identified by image ID (local) and digest (ECR)
- [x] Images pushed to Amazon ECR; ECR login without the password on a command line
- [x] AWS deployment service (ECS/Fargate): task definition revision, UpdateService, rollout wait, failure and timeout detection, revert
- [x] AWS deployments go through `HEALTH_CHECK`; healthy → `SUCCESS`; unhealthy → the Phase 6 rollback
- [x] Rollback on AWS restores the stable **image digest** without rebuilding; `ROLLBACK_FAILED` when that is impossible
- [x] Private repositories through a GitHub App (repository-scoped, read-only, short-lived token)
- [x] Webhook, build, ECR, AWS, health and rollback lines streamed through the existing PostgreSQL → Redis → SSE pipeline
- [x] Deployment history correct; records show trigger, target, image digest and task definition
- [x] Dashboard: settings, trigger and target columns, image version, digest, task definition, commit links
- [x] GitHub, AWS, end-to-end, isolation and regression tests (274 default + 11 Docker); no AWS account needed
- [x] No secrets committed; no credentials in the database, Redis payloads, logs or the browser
- [x] No Phase 8 work: no authentication/OAuth sign-in, monitoring, Kubernetes, autoscaling or multi-region

**Phase 8: production security and monitoring**

- [x] Authentication: scrypt-hashed passwords, server-side sessions in HttpOnly/SameSite=Strict cookies, no tokens in URLs or browser storage
- [x] Authorization enforced server-side: ADMIN/USER, `403` for other users' projects, deployments, logs and settings
- [x] API input validated; rate limits on sign-in, registration, webhooks, deployments, projects and the whole API
- [x] Security headers (API and dashboard CSP), CORS allow-list, cross-site request checks
- [x] No secrets committed (scanned in the tests) or logged (redaction); production configuration check
- [x] GitHub webhook and App tokens protected as before; AWS least privilege, IAM role, SDK timeouts
- [x] Docker execution hardened (`--pull never`, Compose services without capabilities); SSRF protection re-verified
- [x] PostgreSQL: parameterized queries, statement timeouts, justified indexes; Redis: password, AOF, `noeviction`
- [x] Worker failures handled; every deployment operation bounded; lost jobs recovered
- [x] `/health` and `/ready` for the API and the worker; worker heartbeats
- [x] Structured logs; Prometheus metrics; deployment failures and rollbacks observable; dashboard monitoring panel and alerts; Prometheus alert rules
- [x] Audit log; graceful shutdown; backup and recovery procedure; production configuration and checklist
- [x] 378 regular tests (incl. security regression), 22 frontend tests and 11 Docker tests pass; client build passes
- [x] GitHub and AWS configuration changes audited separately; graceful shutdown tested end to end; expired sessions cleaned up; indexes measured
- [ ] Real AWS deployment verified against an AWS account (still only against fakes)

**Phase 9: production validation & release**

- [x] Audit of every component before changes; nothing rewritten
- [x] Real environment: Compose services, production dashboard image, dedicated database and queue prefix; every variable documented
- [x] Real GitHub webhook: ping, unknown repository, wrong branch, correct branch, duplicate delivery, invalid signature
- [x] Real deployment, rollback, first-deployment failure and rollback failure on Docker, with IDs, commits, images and timings recorded
- [x] Concurrency across three projects; GitHub, webhook, PostgreSQL, Redis, worker, build, start-up and health-check failures; SSE recovery in a real browser
- [x] 78 live security checks; secrets scan of the whole history; performance measured (no optimisation without evidence)
- [x] PostgreSQL backup and restore executed; migration recovery documented
- [x] 3 defects fixed with regression tests (worker healthcheck, raw Redis error logs, paused-container rollback reason); `.env.example` completed
- [x] 380 regular, 11 Docker and 22 frontend tests pass; client build passes
- [ ] **Real AWS deployment (ECR, ECS, health check, rollback) — not run, so the release is not ready and `v1.0.0` is not tagged**

**Phase 10: documentation, usability and demo**

- [x] Repository and documentation audit before any change
- [x] README rewritten as an overview with accurate status; topic documents in `docs/`, links and commands checked
- [x] Dashboard usability fixes, each with frontend tests (22 → 30)
- [x] Repeatable demo (`npm run demo`) run against the local stack; demo guide with the recorded output
- [x] Genuine screenshots of the running dashboard
- [x] Setup verified from a fresh clone with empty volumes; a malformed line in `.env.example` that made Compose refuse the file fixed, with a test for both example files
- [x] `npm audit` clean for the API, worker and dashboard
- [x] 382 regular, 30 frontend and 11 Docker tests pass; client build passes
- [ ] **Real AWS deployment: still not run; no `v1.0.0` tag**
