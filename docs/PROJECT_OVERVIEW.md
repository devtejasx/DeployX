# DeployX: project overview

A one-page summary for reviewers and interviewers: the problem, how DeployX solves it, the engineering decisions that matter, the evidence that it works, and what is not done.

## The problem

Shipping a web service means repeating the same steps for every release: build an image from the right commit, start it, check it actually works, and, when it does not, put the previous version back quickly. Done by hand or with a script that only runs `docker run`, a bad release replaces a good one and users see the outage before anyone notices.

DeployX automates that loop for applications in GitHub repositories. A push (or a click) becomes a deployment of that exact commit; the new version only becomes live after an HTTP health check passes; and if it fails, DeployX restores the last healthy version on its own and says so, live, in a dashboard.

## What it does

- Deploys a GitHub repository (public, or private through a read-only GitHub App token) at an exact commit, on every signed push webhook or on demand.
- Builds a Docker image and runs it as an unprivileged, isolated container on the local Docker host, or (implemented, **not validated on real AWS**) pushes it to Amazon ECR and rolls it out on an ECS service.
- Health-checks every deployment; `SUCCESS` only after a 2xx answer. An unhealthy deployment is removed and the last stable version verified and kept live (`FAILED`), or reported as `ROLLBACK_FAILED` when nothing healthy is left.
- Streams every status change and log line to the dashboard over Server-Sent Events.
- Has accounts, sessions, ADMIN/USER authorization, an audit log, rate limits, monitoring, Prometheus metrics and alert rules.

Screenshots of the running application: [demo guide](DEMO_GUIDE.md#screenshots).

## Architecture in one paragraph

A React dashboard talks to an Express API, which owns every write to PostgreSQL (the source of truth) and only records and queues a deployment (BullMQ on Redis). A separate worker process takes jobs (two at a time by default), clones, builds, starts the container on its target, health-checks it and releases or rolls back, writing status and logs to PostgreSQL and publishing them on Redis Pub/Sub; the API relays them to browsers over SSE. Diagrams and details: [README](../README.md#architecture), [Architecture](ARCHITECTURE.md), [Deployment lifecycle](DEPLOYMENT_LIFECYCLE.md).

## Key engineering decisions

| Decision | Why | Where |
| -------- | --- | ----- |
| **The API never deploys; a queue and a worker do.** Job ID = deployment ID. | Requests return in milliseconds; a slow build or a crashed worker never blocks the API. Re-adding a job for the same deployment is a no-op, and a stalled job is handed to another worker, which restarts the attempt. | [`deploymentQueue.js`](../server/src/queues/deploymentQueue.js), [`deploymentProcessor.js`](../worker/src/processors/deploymentProcessor.js) |
| **The state machine lives in PostgreSQL**, as a transition table and a trigger that rejects any other change (`DX001`). | Every writer (API, worker, a manual SQL update) obeys the same rules, so `SUCCESS` without a passed health check is impossible rather than merely unlikely. | [state-machine migration](../server/src/db/migrations/1790671094193_deployment-state-machine.sql), [`deploymentStateMachine.js`](../server/src/services/deploymentStateMachine.js) |
| **The previous version keeps running until the new one is healthy.** | A failed release costs no downtime: the "rollback" verifies the version that never stopped (or restarts it from its image ID, or redeploys its ECR digest) instead of rebuilding anything. In the Phase 9 run, the stable version answered 190 of 190 requests during a failed deployment and its rollback. | [`release.js`](../worker/src/pipeline/release.js), [`rollbackService.js`](../worker/src/services/rollbackService.js) |
| **"Stable" is derived, not stored**: the newest successful deployment of a project. | No flag to keep in sync, and history is never rewritten by a rollback. | `stable_deployment_id()` in the [rollback migration](../server/src/db/migrations/1790767006154_rollback-and-stable-deployments.sql) |
| **One pipeline, two targets.** `LOCAL` and `AWS_ECS` implement the same publish / deploy / restore interface. | GitHub pushes and manual deployments, local and AWS, share the build, health check and rollback code; AWS deployments of one project are serialized by a PostgreSQL advisory lock. | [`dockerDeployment.js`](../worker/src/pipeline/dockerDeployment.js), [`targets/`](../worker/src/targets) |
| **Live logs over SSE, from Redis Pub/Sub with a database safety net.** | SSE needs no extra protocol and reconnects by itself; `Last-Event-ID` resumes without duplicates, and the stream re-reads PostgreSQL periodically so a lost Redis event only delays a line. | [`logStream.controller.js`](../server/src/controllers/logStream.controller.js) |
| **Security at the edges.** The webhook's HMAC is verified in constant time on the raw body before it is parsed; sessions are server-side with only a SHA-256 of the cookie token stored; app containers run with `--cap-drop ALL`, `--pull never`, no mounts and no DeployX variables; health checks refuse private and metadata addresses. | Each input from outside (GitHub, browsers, deployed code) is distrusted where it enters. | [`githubWebhook.service.js`](../server/src/services/githubWebhook.service.js), [`session.service.js`](../server/src/services/session.service.js), [`dockerService.js`](../worker/src/services/dockerService.js), [Security](SECURITY.md) |
| **Tests use real PostgreSQL and Redis, with fakes only at the edges.** | The queue, worker, state machine and SSE run for real in the tests; only Docker (HTTP servers standing in for containers) and AWS (fake ECR/ECS endpoints) are faked, and an opt-in suite runs real clones, builds and containers. | [`server/test/`](../server/test), [Testing](LOCAL_SETUP.md#testing) |

## Evidence that it works

| Evidence | Result |
| -------- | ------ |
| API, worker, integration, security and reliability tests (`npm test`) | **382/382** passed on 2026-10-13 |
| Dashboard tests (`npm run test:client`) | **38/38** passed on 2026-10-13, including contrast and live-region checks |
| Docker end-to-end tests: real clone from GitHub, build, run, health check, rollback (`npm run test:docker`) | **11/11** passed on 2026-10-13 |
| Repeatable demo (`npm run demo`): healthy deploy, failed health check, automatic rollback, stable version still serving | passed three times on 2026-10-13 (32–33 s each), see the [demo guide](DEMO_GUIDE.md) |
| Real-environment validation (Phase 9): real GitHub webhooks, deployments, rollbacks, concurrency, injected PostgreSQL/Redis/worker/GitHub failures, SSE reconnects in a browser, backup and restore | all passed except real AWS, see the [report](PHASE9_VALIDATION.md) |
| Live security checks against the running stack (Phase 9) | 78/78 |
| Measured (Phase 9) | deployment to `SUCCESS` 12.85 s; live log delivery p95 10 ms; API p95 3.6–7.7 ms for health, projects, deployments and logs (37.7 ms for the monitoring overview), sequential, through nginx |

## What is not done

- **Real AWS has never been run.** The ECR/ECS target, its health check and rollback, and the IAM policy are tested only against fakes and by review. This is the release gate: no `v1.0.0` until it passes ([how to run it](PHASE9_VALIDATION.md#repeating-the-validation)).
- The worker drives the host's Docker daemon (root-equivalent there); untrusted code needs a dedicated build host or rootless BuildKit.
- Local apps do not come back by themselves after a Docker host restart.
- No per-application environment variables or build secrets, no OAuth/SSO or MFA, one ADMIN/USER role pair.

More in [Known limitations](../README.md#known-limitations) and the [release checklist](../README.md#release-checklist).
