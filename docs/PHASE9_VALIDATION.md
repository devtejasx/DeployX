# DeployX — Phase 9 Production Validation Report

Date: 2026-10-01 · Code under test: `main` at `53218ef` plus the four fixes listed in [Defects found and fixed](#defects-found-and-fixed).

Phase 9 added no architecture. It ran the system built in Phases 1–8 in a real environment, broke it on purpose, and recorded what happened. Every number below was measured, not estimated.

## Verdict

```text
DEPLOYX PHASE 9 FINAL REPORT

Real GitHub deployment: PASS
Real AWS deployment:    NOT RUN (no AWS account available; AWS path verified only against fakes)
ECR:                    NOT RUN (fakes only)
ECS:                    NOT RUN (fakes only)
Health checks:          PASS
Automatic rollback:     PASS
SSE logs:               PASS
Authentication:         PASS
Authorization:          PASS
Security:               PASS
Monitoring:             PASS
Backup/restore:         PASS

Automated tests:        413/413  (API/worker/integration/security 380, Docker 11, frontend 22)
Docker tests:           11/11
Frontend build:         PASS
Secrets scan:           PASS
Git status:             CLEAN (after the Phase 9 commits)

Release:                NOT READY — the real AWS deployment (ECR + ECS + health check + rollback on AWS)
                        has never been run. No v1.0.0 tag was created.
```

**What would make it READY:** run [Repeating the validation](#repeating-the-validation) once against a real AWS account (an ECR repository, an ECS cluster and service, and the worker's IAM role as documented in the README), with Version A → Version B (unhealthy) → rollback, and record the ECR digest, the task definition revisions and the timings. Everything else on the release checklist is done.

## Environment

| Component | What ran |
| --------- | -------- |
| GitHub | the real repository `devtejasx/DeployX`, throwaway branches `phase9-*` (deleted afterwards), a real repository webhook (push events, `application/json`, HMAC secret), deleted afterwards |
| Public ingress | a `localhost.run` SSH tunnel → the production dashboard image (nginx) → API, i.e. GitHub reached DeployX exactly like a browser does |
| API, worker | the Docker Compose services built from the code under test |
| Frontend | the **production** dashboard image (`client/Dockerfile`, target `production`: nginx, strict CSP) on `:18080` |
| PostgreSQL 17, Redis 7 | the Compose services; a dedicated database `deployx_phase9` and queue prefix `deployx-phase9`, so development data was untouched |
| Docker | Docker Desktop 29.8 (containerd image store), target `LOCAL` |
| Accounts | created with `npm run user:create` (registration off): one ADMIN, two USERs |
| AWS | **none**: no account or credentials exist in this environment |

The validation app (`examples/validation-app/`) behaves according to a committed `version.json`, so each scenario was a real commit pushed to GitHub: `healthy`, `unhealthy` (`/health` → 503), `hang` (`/health` never answers), `crash` (exits on start), `build-fail` (the Docker build fails).

## Step 1 — Audit

Inspected before any change: GitHub webhook service and route, API, migrations (8, applied cleanly to an empty database), BullMQ queue and worker, Docker build/run path, ECR/ECS services, health checks, rollback service, SSE controller and client hook, authentication, authorization, rate limits, monitoring, tests, README and environment files. The implementation matched its documentation; nothing was rewritten.

**Baseline before any change:** 378/378 API tests, 11/11 Docker end-to-end tests, 22/22 frontend tests, frontend production build passing.

**State machine note.** The spec draws `HEALTH_CHECK → FAILED → ROLLING_BACK`. DeployX (since Phase 6) runs `HEALTH_CHECK → ROLLING_BACK → FAILED` (or `→ ROLLBACK_FAILED`): `FAILED` is final and closes the live stream, so it cannot come before the rollback. The stable version's health check runs *inside* `ROLLING_BACK` and is fully logged; the stable version keeps its own record (`SUCCESS`, stable) and does not go through `HEALTH_CHECK` again as a status. This design was kept.

## Step 3 — Real GitHub webhook

All six cases used deliveries sent by GitHub itself (pushes, and GitHub's redelivery API).

| Case | How | Result |
| ---- | --- | ------ |
| Ping | creating the webhook | `200 Webhook is configured` |
| Unknown repository | real push before any project used the repository | `404 No DeployX project uses repository devtejasx/DeployX`, nothing created |
| Wrong branch | real push to `phase9-other` | `200 No project deploys branch phase9-other: push ignored`, each of the 5 projects listed with its reason |
| Correct branch | real push to `phase9-validation` | `202`, deployment created with trigger `GITHUB_PUSH` and the exact commit |
| Duplicate delivery | GitHub redelivery of the same push (same GUID) | `200 Already deployed: this commit was received before`, same deployment ID, `duplicate: true` |
| Invalid signature | (a) the webhook's secret changed on GitHub, real delivery redelivered; (b) forged requests from the internet with a wrong signature, no signature, or only the SHA-1 header | (a) `401 Invalid webhook signature`; (b) `401` each; the audit log has `webhook.rejected` entries |

## Step 4 — Real deployment

`git push` → GitHub → webhook → API → PostgreSQL → BullMQ → worker → git clone → Docker build → container → health check → `SUCCESS`, observed live over SSE: `BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS`.

| | |
| - | - |
| Deployment ID | `8ea74779-7d39-40d7-941f-3fe9ffba3d20` |
| Commit SHA | `ab0f03339fe7521df5d7e6d86192469ad8de2296` (branch `phase9-validation`) |
| Docker image | `deployx/p9-app-850c28a6:ab0f03339fe7` (+ `:deployment-8ea74779-…`) |
| Image ID | `sha256:6f55d6a3d9b139d4d8e6a62c8d7453604860c4770e36b44801cb1db042530a5f` |
| Container | `deployx-850c28a6-…-8ea74779-…`, port 3000 on `127.0.0.1:10125` |
| ECR image / ECS task | not run (no AWS account) |
| Health check | `PASSED`, attempt 1/5, HTTP 200 in 20 ms, after the 5 s start-up grace period |
| Duration | 12.85 s from deployment creation to `SUCCESS`; 19 s from `git push` |
| Phases | clone 2.76 s · Docker build 1.58 s · container start 3.39 s · health check 5.03 s |

## Step 5 — Real rollback

Version B (`8e8efd4`, `/health` → 503) pushed while Version A was stable:

```text
B  BUILDING → DEPLOYING → HEALTH_CHECK (5 × HTTP 503) → ROLLING_BACK
   → "Stable container … is still running" → health check of A: HTTP 200 in 9 ms
   → "Rollback completed successfully: deployment 8ea74779 is live" → FAILED
```

- B: `FAILED`, `rollback_status COMPLETED`, `rollback_deployment_id` = A, 21.3 s; B's container removed.
- **A stayed intact and kept serving**: 190 of 190 requests to A during B's whole deployment and rollback succeeded, all answered by version A.
- A's record unchanged (same status, container, `updated_at`), one log line appended: *Restored as the live version: deployment a2fa4252… failed its health check*.
- The same sequence arrived over SSE (`… HEALTH_CHECK → ROLLING_BACK → FAILED → end`), and the dashboard history shows *Automatic rollback completed · restored #1*.

## Step 6 — First deployment failure

Project `p9-first-fail` (no previous deployment), unhealthy app pushed: `HEALTH_CHECK → FAILED` with `rollback_status NOT_AVAILABLE` and *No previous stable deployment available for rollback.* The status never entered `ROLLING_BACK`; the container was removed; nothing kept running.

## Step 7 — Rollback failure

Both the new and the previous stable version unhealthy, two ways:

| Variant | How A was broken | Result |
| ------- | ---------------- | ------ |
| A frozen | `docker kill -s STOP` on A's process (container running, port open, `/health` never answers) then unhealthy D pushed | `ROLLING_BACK` → health check of A: 5 × *timed out after 2000ms* → `ROLLBACK_FAILED`, rollback `FAILED`: *the stable deployment is unhealthy too* |
| A paused | `docker pause` on A, then unhealthy C pushed | `ROLLBACK_FAILED` at once. The reason was wrong (*no published port*): fixed, now *the stable container is paused* |

No false `SUCCESS` and no *Rollback completed* line in either case; A's record untouched; A served again once resumed.

## Step 8 — Concurrency

One `git push` of three branches → three simultaneous GitHub deliveries → three projects (`p9-conc-a` healthy, `-b` unhealthy, `-c` healthy), worker concurrency 2.

- a and c ran in parallel (13.1 s, 13.2 s); b waited **13.0 s in `QUEUED`** (visible live over SSE) and then failed on its own (`NOT_AVAILABLE`), affecting nothing else.
- Isolation check (0 problems): no status events of another deployment and no other project's IDs or commits on any stream; images namespaced per project (`deployx/p9-conc-a-33faa5f6:…`); every container's labels match its own project and deployment; each live container serves its own version; p9-app's live version untouched.

## Step 9 — Failure testing

| Failure | How it was produced | Meaningful end state |
| ------- | ------------------- | -------------------- |
| GitHub unavailable | worker recreated with `github.com` → 127.0.0.1 | clone *Failed to connect to github.com:443*, retried after 2 s and 4 s, `FAILED`; recovered by redeploying once GitHub was reachable |
| Webhook delivery failure (API down) | API container stopped during a real push | GitHub gave up after 10 s; nginx held the connection and delivered once the API was back; GitHub's redelivery was deduplicated → **exactly one** deployment, `SUCCESS` |
| PostgreSQL unavailable | Postgres stopped ~25 s, real push meanwhile | `/health` 200, `/ready` 503 naming `postgres`, generic `500` without internals, webhook `500`; API and worker recovered without restarts; redelivery → `202` → `SUCCESS` |
| Redis unavailable | Redis stopped ~20 s | `/ready` 503 naming `redis`; manual deployment `503` *queue is unavailable* and recorded `FAILED` (never stuck in `QUEUED`); worker reconnected on its own; a push lost meanwhile was redelivered → `SUCCESS` |
| Worker crash | `docker kill` of the worker 4 s into a build | the replacement worker detected the stalled job (*A worker stopped while running this job; it is handed out again*), removed the half-started container, rebuilt → `SUCCESS` (71 s incl. 22 s downtime) |
| Docker build failure | `build-fail` commit | build error stored, 3 attempts with backoff, `FAILED`, no image or container |
| Docker startup failure | `crash` commit | *Container exited immediately (exit code 1)*, 3 attempts, `FAILED`, container removed |
| Health-check timeout | `hang` commit | 5 × 2 s timeouts → rollback to A completed → `FAILED` |
| Rollback failure | Step 7 | `ROLLBACK_FAILED` |
| ECR failure, ECS failure, AWS API timeout | **not run for real**; covered by the AWS fakes (`aws-services.test.js`, `aws-deploy.test.js`, `deployment-timeouts.test.js`) | — |
| Browser disconnect / SSE reconnect | Step 10 | no lost or duplicated lines |
| Docker host restart (unplanned) | the machine restarted during the session | DeployX's services came back; **deployed app containers did not** (see [Known limitations](#known-limitations-found)) |

## Step 10 — SSE

- **Normal deployment**, live: `QUEUED → BUILDING → DEPLOYING → HEALTH_CHECK → SUCCESS → end`.
- **Rollback**, live: `BUILDING → DEPLOYING → HEALTH_CHECK → ROLLING_BACK → FAILED → end`.
- **Client disconnect** (API client): disconnected after 3 s, reconnected 5 s later with `Last-Event-ID`: 100 stored log lines, 100 received across both connections, 0 missing, 0 duplicates.
- **Network drop in a real browser** (production dashboard): nginx restarted in the middle of a deployment. The dashboard showed *Reconnecting…*, then *Live* again 3 s later, then `ROLLING_BACK`, `FAILED`, *Stream closed*. 42 log lines stored, 42 shown, 0 missing, 0 duplicates.
- Delivery latency of live log lines (database commit → browser): p50 6 ms, p95 10 ms, max 18 ms.

## Step 11 — Security

78 checks against the running stack, all passing in one run:

- **Authentication:** every resource endpoint `401` anonymously; forged cookie `401`; a session is useless after sign-out; wrong password and unknown account get the same answer; sign-in brute force `429` after 5 attempts per account; registration `403` in production mode.
- **Authorization:** two USERs and an ADMIN. A USER cannot read, list, deploy, reconfigure or delete another account's project, read its deployments or logs, or open its live stream (all `403`); lists are scoped; ADMIN sees everything; status changes are ADMIN-only; a USER's audit log holds only that user's entries; the attacked project was unchanged afterwards.
- **Input / repository validation / injection:** non-GitHub, `file://`, shell metacharacters, embedded credentials, branches like `--upload-pack=…` and `$(id)`, Dockerfile path traversal and absolute paths, health paths to another host, an AWS service URL to the metadata address, unknown fields, out-of-range ports, non-hex commits, malformed IDs, non-JSON bodies: all `400`/`415`.
- **CORS / CSRF:** no CORS headers for foreign origins (also on preflight); the dashboard origin allowed with credentials; a cross-site state-changing request with a valid cookie `403`.
- **Headers:** API CSP `default-src 'none'`, `nosniff`, `DENY`, `no-referrer`; dashboard CSP `script-src 'self'` without `unsafe-inline`; no server version; session cookie `HttpOnly; SameSite`. HSTS is sent only with `NODE_ENV=production` (this stack was HTTP), as designed.
- **Proxy:** with `TRUST_PROXY=1` the audit log records the real client address and an `X-Forwarded-For` sent through nginx cannot borrow another address.
- **Secret exposure:** the webhook secret, metrics token, all three passwords, database/Redis credentials and session tokens appear in none of the API/worker/nginx logs, API responses or the JavaScript bundle; deployed apps get no DeployX variables, run unprivileged with `CapDrop ALL`, no mounts, `no-new-privileges`. `/metrics` `401` without the token.
- **SSRF:** the worker refuses private and metadata addresses (regression tests); the API refuses such service URLs.
- **AWS permissions:** reviewed only (the least-privilege policy in the README); not exercised against IAM.
- **Secrets scan:** all 79 commits: no `.env` ever committed; the only key-shaped strings (6 hits for AWS-key, GitHub-token and PEM patterns) are fake fixtures in the redaction tests `observability.test.js` and `security-regression.test.js`: a made-up AWS key ID, AWS's own documented example key, a fake GitHub token and truncated PEM blocks; none of this session's secrets or passwords in the history or working tree.

## Step 12 — Performance

Measured on one Windows 11 machine with Docker Desktop. **No optimisation was made**; the bottlenecks are recorded.

| Measure | Result |
| ------- | ------ |
| API latency through nginx, sequential (p50 / p95) | `/api/health` 2.1 / 3.6 ms · projects 4.3 / 6.4 ms · deployments of a project 5.5 / 7.7 ms · one deployment 4.2 / 5.2 ms · logs 5.3 / 6.5 ms · monitoring overview 7.5 / 37.7 ms |
| 20 concurrent clients × 5 requests | p50 50.5 ms, p95 73.9 ms, max 84.5 ms, 0 errors, 356 req/s |
| Successful deployment, total | 12.2 – 14.3 s (71 s when the worker was killed mid-build) |
| Queue wait | 0.01 – 0.03 s; 13.0 s when both worker slots were busy |
| Clone from GitHub | 2.4 – 3.2 s |
| Docker build (base image cached) | 0.6 – 2.2 s |
| Container start | 3.3 – 3.9 s |
| Health check (healthy) | 5.0 s |
| Health check (unhealthy, 5 attempts) | 13.1 s; with 2 s timeouts 23.5 s |
| AWS deployment duration | not measured (no AWS) |
| SSE delivery | p50 6 ms, p95 10 ms |

**Bottlenecks:** about 8 of the ~12 s of a successful deployment are **configured waits**, not work: `CONTAINER_STARTUP_GRACE_MS` (3 s) and `HEALTH_CHECK_STARTUP_GRACE_MS` (5 s). They can be lowered per environment for apps that start fast. The next cost is the full clone from GitHub (~2.7 s). Throughput is bounded by `WORKER_CONCURRENCY` (2): a third simultaneous deployment waits for a slot. The API is far from being a bottleneck.

## Step 13 — Backup and restore

The documented procedure was executed against the validation database:

1. Fingerprint: row counts, the stable deployment of each project, and an md5 over every deployment row and every log line.
2. `pg_dump --format=custom --no-owner` → 87 KB in 0.6 s, copied off the database host.
3. Disaster: API and worker stopped, **all 21 deployments and their 759 log lines deleted**.
4. `pg_restore --clean --if-exists --no-owner` (0.8 s) → `npm run migrate` (*Nothing to migrate*) → services started.
5. Fingerprint after restore: **identical** (users 3, projects 6, deployments 21, logs 759, audit 105, same stable deployments, same md5 of deployments and logs). The dashboard history and live app were as before.

**Migration recovery**, on a separate copy: `migrate down` of the newest migration, then `migrate up`. Deployment history survived unchanged (same md5), but that migration's down step drops what it introduced: roles, password hashes, sessions and the **audit log** (105 → 0 entries; all accounts back to `USER` without a password). So reverting a migration is not a data-preserving recovery. In production, recover from a failed or bad migration by restoring the backup taken before it. The README now says so.

**Redis** is not the record of deployment history: after the Redis outage, history, stable versions and logs were complete (they are in PostgreSQL), and a deployment whose job could not be queued was recorded `FAILED`, not lost.

## Step 14 — Production configuration checklist

The configuration itself is enforced: with `NODE_ENV=production` and the development settings the API **refuses to start** (`unsafe_configuration`: *DATABASE_URL uses a missing or development password*, *REDIS_URL has no password or the development one*).

| Item | Status in this validation |
| ---- | ------------------------- |
| No development secrets | enforced at start-up in production; this stack used development DB/Redis passwords (local only) |
| No test credentials | the test accounts lived only in `deployx_phase9` |
| Correct GitHub webhook | verified for real (Step 3); the validation webhook was deleted afterwards |
| Correct AWS region / ECR repository / ECS configuration | **not verifiable without AWS** |
| Correct database / Redis | verified (`/ready`, recovery tests) |
| Correct frontend origin | `CLIENT_URL` matched the dashboard; foreign origins refused |
| Secure authentication | verified (Step 11) |
| Secure CORS | verified |
| Security headers | verified (HSTS needs `NODE_ENV=production` + HTTPS) |
| Logging enabled | JSON logs from API and worker, no secrets in them; after the fix, none of them raw |
| Monitoring enabled | dashboard overview with worker heartbeat, queue and alerts (it raised `ROLLBACK_FAILED`, `REPEATED_ROLLBACK`, `HIGH_FAILURE_RATE` for this session's events); `/metrics` with token; the worker's `/health` and `/ready` |

Two configuration points were added to the README checklist: `TRUST_PROXY` must equal the number of proxies in front of the API (check that the audit log shows real client addresses), and with `TRUST_PROXY` set the API port must only be reachable through that proxy.

## Step 16 — Test suites (final run, with the fixes)

| Suite | Result | Time |
| ----- | ------ | ---- |
| API, worker, integration, queue, state machine, SSE, health check, rollback, GitHub, AWS mocks, auth, authorization, security regression, reliability (`npm test`) | **380/380** | 88 s |
| Docker end-to-end (`npm run test:docker`, clones from GitHub) | **11/11** | 2.4 min |
| Frontend (`npm run test:client`) | **22/22** | 2 s |
| Frontend production build | **PASS** | 0.2 s |
| Live security checks (Step 11) | **78/78** | |
| Real-environment scenarios (Steps 3–10, 13) | all **PASS** except AWS (**NOT RUN**) | |

## Step 17 — Release checklist

| | |
| - | - |
| [x] Git status clean | after the Phase 9 commits |
| [x] No secrets committed | scanned (Step 11) |
| [x] README complete | Phase 9 section, documentation index, limitations, checklist |
| [x] `.env.example` complete | 6 worker settings and 2 tooling variables were missing; added |
| [x] Database migrations verified | 8 migrations on an empty database; restore + migrate; down/up on a copy |
| [x] Tests passing | 413/413 |
| [x] Docker tests passing | 11/11 |
| [x] Frontend build passing | |
| [x] GitHub webhook tested | for real |
| [ ] **Real AWS deployment tested** | **not run: no AWS account** |
| [x] Real health check tested | |
| [x] Real rollback tested | on local Docker; **not on AWS** |
| [x] Monitoring tested | |
| [x] Backup tested | |
| [x] Security checks passed | |

**Step 18:** the `v1.0.0` tag was **not** created, because the release checklist is not complete.

## Defects found and fixed

| # | Found in | Defect | Fix |
| - | -------- | ------ | --- |
| 1 | Step 9, PostgreSQL outage | The Compose **worker was always reported `unhealthy`**: its healthcheck called `http://localhost:9464`, `localhost` resolves only to `::1` in the Alpine image, and the monitoring server listens on IPv4. | `docker-compose.yml` uses `127.0.0.1`. Verified: the worker turns `healthy`. |
| 2 | Step 9, Redis outage | During a Redis outage the worker printed **raw multi-line stack traces** outside the JSON logs: the recovery service's BullMQ queue had no `error` listener, so BullMQ fell back to `console.error`. | The queue's errors go through the logger (`recovery_queue_error`). Regression test added. Verified: 0 non-JSON lines in a repeated outage. |
| 3 | Step 7, paused stable container | A paused stable container produced the wrong rollback reason (*the stable container has no published port*): Docker reports no ports while a container is paused. | Reported as *the stable container is paused*. Regression test added (the fake Docker now models pause like Docker does). Outcome was already correct (`ROLLBACK_FAILED`). |
| 4 | Step 2 | 8 variables read by the code were missing from `.env.example`. | Added. |

## Known limitations found

- **Real AWS is unverified.** See the verdict.
- **Deployed LOCAL apps do not survive a Docker host restart.** Apps run with `--restart no` (deliberately: a crashing app must fail its deployment instead of restarting in a loop) on an ephemeral host port. After the machine restarted, DeployX's own services came back but the deployed apps stayed `Exited`, while their deployments still show `SUCCESS`/stable. `docker start` brings them back on **new** host ports. Rollbacks still work, because they read the live port from Docker, but the recorded port is stale. **Recovery: redeploy the stable commit of each project.** On AWS ECS the service scheduler replaces stopped tasks, so this applies to the LOCAL target only.
- **Reverting the Phase 8 migration** drops roles, password hashes, sessions and the audit log (Step 13). Use the pre-migration backup instead.
- **Webhook timeouts:** GitHub waits 10 s for a delivery. If the API is unreachable behind a proxy that holds connections longer, GitHub records a failure even though the delivery may still be processed later. Deduplication makes the redelivery safe, so redeliver failed deliveries.
- The free tunnel used for this validation rotated its domain twice and dropped once, losing deliveries. That is the tunnel, not DeployX. Production needs a stable HTTPS endpoint.

## Repeating the validation

1. Run the stack from `main`, with `GITHUB_WEBHOOK_SECRET`, `METRICS_TOKEN`, `TRUST_PROXY=1`, `ALLOW_REGISTRATION=false`, the production dashboard image, and accounts from `npm run user:create`.
2. Expose the dashboard over HTTPS and add a repository webhook (push, JSON, the secret) to `<origin>/api/webhooks/github`.
3. Create a project for `examples/validation-app/Dockerfile` (port 3000, health check `/health`) on a test branch. Change `examples/validation-app/version.json` and push for each scenario: `healthy` (A), `unhealthy` (B), `hang`, `crash`, `build-fail`.
4. For AWS, also set `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_ECS_CLUSTER`, give the worker its IAM role, set the project to `AWS_ECS` with its service and URL, and repeat A → B.
5. Delete the webhook and the test branches afterwards.
