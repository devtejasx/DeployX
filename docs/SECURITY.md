# Security

DeployX runs other people's code from GitHub, holds GitHub and AWS credentials on its worker, and accepts webhooks from the internet, so its security model is about keeping those apart. This document covers accounts and sessions, authorization, request hardening, rate limits, secrets, webhook verification, container isolation, SSRF protection and the audit log. Operating concerns (logs, metrics, backups, the production checklist) are in [Operations](OPERATIONS.md).

```text
                    GitHub (signed webhooks)        Browser (session cookie)
                              │                               │
                              ▼                               ▼
              ┌──────────────────────────────────────────────────────────┐
              │ DeployX API                                              │
              │  security headers · CORS allow-list · CSRF origin check  │
              │  rate limits (Redis) · request IDs · JSON-only bodies    │
              │  authentication (sessions) · authorization (ADMIN/USER)  │
              │  /health · /ready · /metrics · audit log                 │
              └──────────────┬───────────────────────────┬───────────────┘
                             │                           │
                     ┌───────▼────────┐          ┌───────▼────────┐
                     │ PostgreSQL     │◄─────────┤ Redis / BullMQ │
                     │ source of truth│          │ queue, events, │
                     │ users, sessions│          │ rate limits,   │
                     │ audit log      │          │ heartbeats     │
                     └───────▲────────┘          └───────┬────────┘
                             │                           │
                     ┌───────┴───────────────────────────▼───────┐
                     │ Worker: timeouts · recovery check ·       │
                     │ heartbeat · /health · /ready · /metrics   │
                     └───────────────────┬───────────────────────┘
                                         ▼
                              Docker (LOCAL) / AWS ECR + ECS

      Prometheus scrapes /metrics ──► alert rules ──► Alertmanager ──► Slack / email / PagerDuty
      JSON logs on stdout ──► CloudWatch Logs / Loki / any log pipeline
```

## Authentication

- **Accounts** have a name, an email (stored lower-case) and a password hashed with **scrypt** (Node's built-in memory-hard KDF; N = 2^17, r = 8, p = 1, 128 MiB, the OWASP recommendation; `PASSWORD_HASH_COST`). Hashes carry their parameters, so the cost can be raised later; weaker hashes are re-hashed at the next sign-in. Passwords: 12–256 characters.
- **Sessions** are server-side (`sessions` table). The browser gets a random 256-bit token in a cookie that is **HttpOnly** (JavaScript cannot read it), **SameSite=Strict** (other sites cannot send it), **Secure** and `__Host-` prefixed in production. PostgreSQL stores only the token's **SHA-256**. Sessions end after `SESSION_TTL_HOURS` (12), after `SESSION_IDLE_TIMEOUT_MINUTES` (60) without a request, on sign-out, or when the user is deleted. Expired and idle sessions are deleted every `SESSION_CLEANUP_INTERVAL_MS` (1 h).
- Tokens are **never** in a URL, a response body, `localStorage` or a log. The dashboard does not see them at all.
- **Sign-in errors are uniform**: an unknown email, an account without a password and a wrong password all answer `401 Invalid email or password`, after the same amount of hashing work.
- **Registration** (`POST /api/auth/register`) is on in development and **off by default in production** (`ALLOW_REGISTRATION`). The first account created while no ADMIN exists becomes ADMIN (serialized by an advisory lock, so only one can); every later one is a USER. The role can never be chosen by the client.
- **Command line accounts** (production bootstrap, password resets). The password is read from stdin or `DEPLOYX_USER_PASSWORD`, never from the command line:

  ```bash
  printf '%s\n' "$ADMIN_PASSWORD" | npm --prefix server run user:create -- --email admin@example.com --name "Admin" --role ADMIN
  ```

  **Upgrading from Phase 7:** the projects created so far belong to the development user `dev@deployx.local`, which has no password. Either give it one (`npm run user:create -- --email dev@deployx.local --role ADMIN`), or register a new account: it becomes ADMIN and sees every project.

| Endpoint | |
| -------- | - |
| `POST /api/auth/register` | `{ name, email, password }` → `201 { user }` and a session cookie; `403` when registration is disabled |
| `POST /api/auth/login` | `{ email, password }` → `200 { user }` and a session cookie; `401` otherwise |
| `POST /api/auth/logout` | ends the session on the server, clears the cookie |
| `GET /api/auth/me` | `{ user: { id, name, email, role } }`, or `401` |

With curl, keep the cookie in a file:

```bash
curl -s -c cookies.txt -X POST localhost:5000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "<password>"}'
curl -s -b cookies.txt localhost:5000/api/projects
```

Every `curl` example in these documents sends `-b cookies.txt`. Keep the password out of your shell history: put the JSON body in a file and send it with `-d @login.json` (see [Calling the API from the command line](API.md#calling-the-api-from-the-command-line)).

## Authorization (RBAC)

Enforced by the API on every request, in the services ([`access.js`](../server/src/services/access.js)). The dashboard hides nothing for security; the API refuses.

| | USER | ADMIN |
| - | ---- | ----- |
| Create projects (owned by the signed-in user; `user_id` is never accepted from the body) | ✓ | ✓ |
| Read, change, delete, deploy **own** projects; read their deployments, logs and live stream | ✓ | ✓ |
| The same for **other users'** projects | `403` | ✓ |
| `PATCH /api/deployments/:id/status` (manual status override) | `403` | ✓ |
| `POST /api/deployments/:id/logs` (raw log lines) | `403` | ✓ |
| `GET /api/audit-logs` | own entries | all entries |
| `GET /api/monitoring/overview` | own deployments + shared infrastructure | everything, incl. worker host names |
| Database/Redis error details in `/api/system/status` | hidden | shown |

A resource that does not exist is `404`; one that exists but is someone else's is `403` (IDs are random UUIDs, so this reveals nothing useful). GitHub and AWS settings are project fields, so they follow the project's rules. Every `403` for a signed-in user is written to the audit log (`access.denied`).

## API security

- **Validation:** every body is a zod `strictObject` (unknown or read-only fields are refused), every ID a UUID, every query string validated. Repository URLs, branches, commit SHAs, Dockerfile paths, ports, health-check paths, ECS service names and service URLs are checked by the API, by PostgreSQL `CHECK` constraints and again by the worker. `status` can only be set through the state machine.
- **Bodies:** JSON only. A body with another content type (what a cross-site HTML form can send) is refused with `415` before it is read; the limit is 100 KB (`413`; webhooks 5 MB).
- **Headers** (Helmet): `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; …` (the API serves only JSON), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Strict-Transport-Security` in production, `Cache-Control: no-store`, no `X-Powered-By`.
- **CORS:** only the origins in `CLIENT_URL` (comma-separated) get CORS headers, with credentials. The `Origin` header is compared with that list, never echoed; `*` is never accepted.
- **Cross-site request forgery:** besides the SameSite=Strict cookie, a state-changing request from a browser must come from the API's own origin or a `CLIENT_URL` origin (`Origin` / `Sec-Fetch-Site` checked), else `403 CROSS_ORIGIN_REQUEST`.
- **Errors** have the same shape in development and production, with a stable code: `{ "success": false, "error": { "code": "NOT_FOUND", "message": "Project not found" } }`. Codes: `VALIDATION_FAILED`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `CROSS_ORIGIN_REQUEST`, `NOT_FOUND`, `CONFLICT`, `INVALID_STATE_TRANSITION`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`. Stack traces, SQL, connection strings and file paths only go to the server log, tagged with the request ID that is also returned in `X-Request-Id`.
- **Production configuration check:** with `NODE_ENV=production` the API **refuses to start** when `DATABASE_URL` or `REDIS_URL` use a missing or development password, `CLIENT_URL` is missing, `*` or not HTTPS, the session cookie is not Secure, `PASSWORD_HASH_COST` is below 15, or `GITHUB_WEBHOOK_SECRET` is shorter than 20 characters.

## Rate limiting

Fixed windows counted in **Redis** ([`rateLimit.js`](../server/src/middleware/rateLimit.js), express-rate-limit), so all API instances share them. If Redis is unreachable, the limits are counted **in memory** per instance: never "no limit", and never an outage of the API. Over a limit: `429 RATE_LIMITED` with `Retry-After` and `RateLimit` headers.

| Limit | Default | Key |
| ----- | ------- | --- |
| Every `/api` request (except probes and webhooks) | 300 / minute | client IP |
| Failed sign-ins | 10 / 15 minutes | client IP (correct sign-ins do not count) |
| Failed sign-ins per account | 5 / 15 minutes | email, from any IP |
| Registrations | 5 / hour | client IP |
| Webhook deliveries | 120 / minute | client IP |
| New deployments | 20 / minute | signed-in user |
| New projects | 30 / hour | signed-in user |

All are configurable (`RATE_LIMIT_*`). Behind a load balancer set `TRUST_PROXY` (e.g. `1`) so the client IP is the real one.

## Secrets

- **Nothing secret is committed.** `.env` is git-ignored; `.env.example` holds only local development defaults. The test suite scans every tracked file for private keys, AWS keys and GitHub/Slack/Stripe tokens and fails if it finds one; the git history was scanned when Phase 8 started (clean).
- **Where each secret lives:** `GITHUB_WEBHOOK_SECRET` and the session table only in the API; `GITHUB_APP_PRIVATE_KEY` and AWS credentials only in the worker (preferably an **IAM role**, so there are no AWS keys at all); `METRICS_TOKEN` in both; passwords nowhere (hashes only).
- **Never in logs:** the logger redacts values under sensitive keys (password, token, secret, authorization, cookie, private key, access key, credentials, signature) and scrubs every string of credentials in URLs, bearer tokens, GitHub tokens (`ghp_`/`ghs_`/`github_pat_`), AWS access keys and PEM private keys. Request logs never contain headers, cookies or bodies. Build output is scrubbed as before. Child processes (`git`, `docker`) still inherit only an allow-list of variables.
- **Never in the browser:** the dashboard uses no `VITE_*` variables (anything named so is public in the bundle), and the API never returns a secret, a password hash or a session token.
- In production, inject secrets from a secret store (AWS Secrets Manager / SSM Parameter Store into the ECS task definition, Docker/Kubernetes secrets), not from files in the image.

## GitHub webhooks and the GitHub App

Re-audited; nothing weakened. Signatures are still verified (HMAC-SHA256, constant time) **before** the body is parsed, and without a secret every delivery is refused (`503`). New: deliveries are rate-limited, every accepted push and every refused signature is audited (`webhook.push`, `webhook.rejected`), and `deployx_webhook_deliveries_total{outcome}` counts them. The App's private key never leaves the worker; installation tokens are created per deployment, scoped to **one repository** with **`contents: read`**, expire within an hour, are passed to git in its environment (never its arguments, `.git/config` or output) and are never stored or logged. The repository is checked against the canonical `https://github.com/<owner>/<repo>` form by the API, the database and the worker.

## AWS security (least privilege)

The worker calls exactly these AWS APIs: ECR `GetAuthorizationToken`, `DescribeRepositories`, `DescribeImages` and the layer-upload actions used by `docker push`; ECS `DescribeServices`, `UpdateService`, `DescribeTaskDefinition`, `RegisterTaskDefinition` (and `TagResource` to keep task definition tags). It does **not** call CloudWatch, IAM (other than `PassRole` for the task's existing roles), EC2 or anything that creates or deletes infrastructure. The [IAM policy in the deployment lifecycle](DEPLOYMENT_LIFECYCLE.md#aws-deployment-architecture) is therefore the complete worker policy. It has been reviewed but **not exercised against real IAM**, since no AWS account was available for validation; attach it to an **IAM role** (the ECS task role of the worker, or the EC2 instance profile) rather than creating access keys. Never use `AdministratorAccess`.

Your application tasks' *execution role* (not the worker) needs the usual `AmazonECSTaskExecutionRolePolicy` (ECR pull, CloudWatch Logs `CreateLogStream`/`PutLogEvents` for the `awslogs` driver).

Every AWS SDK client has a 5 s connection timeout, a 30 s request timeout (`AWS_CONNECTION_TIMEOUT_MS`, `AWS_REQUEST_TIMEOUT_MS`) and 3 SDK attempts for throttling and transient errors. Permission errors (`AccessDeniedException`, invalid credentials, missing resources) fail the deployment at once without retries, with AWS's message (never credentials) in the log.

## Docker security

Re-audited against injection through repository URL, image name, container name, environment, ports, volumes and commands:

- **No shell anywhere**: `git` and `docker` run through `spawn` with argument arrays; user values come after `--`; the regression suite passes `; rm -rf /`, `$(id)`, backticks and option-looking strings through and checks they arrive verbatim.
- **Names are DeployX's**: image and container names are built from a sanitized slug and UUIDs; projects cannot choose them. Ports are integers. There are no user-supplied environment variables, volumes, commands or networks.
- **Containers**: not privileged, `--cap-drop ALL` plus 8 common capabilities, `no-new-privileges`, memory/CPU/PID limits, bounded log files, no volumes or bind mounts, no Docker socket, no DeployX variables, an isolated network with inter-container traffic disabled, ports published on 127.0.0.1 only, and now **`--pull never`**: only images the worker built (or restores by ID) ever run.
- **DeployX's own Compose services** (API, worker, client, migrate) run as non-root with `cap_drop: [ALL]` and `no-new-privileges`. The production dashboard image is unprivileged nginx (uid 101).
- **Remaining limitation:** the worker still drives the host's Docker daemon through its socket (root-equivalent on that host), and builds run with the daemon's privileges. For untrusted code in production, run the worker on a **dedicated build host or VM** with nothing else on it, or use rootless Docker/BuildKit, or a sandboxed runtime (gVisor, Kata); AWS deployments can build with CodeBuild instead. This was not changed in Phase 8 because it requires infrastructure, not code.

## SSRF protection

Health checks of local containers go only to `HEALTH_CHECK_HOST` / loopback on the container's published port, with a validated path. Health checks of AWS services resolve the host **once**, check **every** address it resolves to, and send the request to exactly that checked address (no second lookup, so **DNS rebinding cannot redirect it**); redirects are never followed. Always refused: link-local and metadata addresses (`169.254.0.0/16` incl. `169.254.169.254` and `169.254.170.2`, `fe80::/10`, `fd00:ec2::254`, IPv4-mapped forms), unspecified, multicast and reserved ranges. Private and loopback addresses are refused unless `HEALTH_CHECK_ALLOW_PRIVATE_URLS=true`. The API also refuses service URLs that are not plain http(s) origins. Covered by [`security-regression.test.js`](../server/test/security-regression.test.js).

## Database security

- All SQL is parameterized; the only dynamic SQL fragments are column names taken from fixed allow-lists. Migrations are tracked in `pgmigrations` and every one has a down migration (tested).
- Foreign keys, `CHECK` constraints and the state-machine trigger still reject invalid rows for every writer. New tables: `sessions` (token hashes only, cascade with their user) and `audit_logs` (append-only, survive their user).
- **Statement timeouts**: 15 s for the API, 30 s for the worker (`DATABASE_STATEMENT_TIMEOUT_MS`); waiting for a project lock is exempt (it waits for another, bounded deployment).
- **Indexes** were added only for queries that run continually: `deployments_unfinished_idx` (partial, unfinished deployments: the recovery check every minute and the dashboard's overview every 5 s) and `deployments_finished_at_idx` (the overview's 24-hour outcomes); `sessions` by token hash (unique), user and expiry; `audit_logs` by time and user. Existing indexes already cover project and deployment lookups.
- Use a dedicated database user with rights only on the DeployX database, TLS (`?sslmode=require`) to a managed PostgreSQL in production, and never expose port 5432 publicly.

## Redis and BullMQ

- Password required, bound to 127.0.0.1 in Compose; in production use a private network and TLS (`rediss://` URLs work as-is).
- Compose now runs Redis with `--appendonly yes` (queued jobs survive a restart) and `--maxmemory-policy noeviction` (BullMQ's requirement: Redis refuses writes instead of silently dropping queue keys).
- Redis holds only identifiers (job payloads are deployment/project IDs, branch and commit), rate-limit counters, worker heartbeats and Pub/Sub notifications: **no secrets and nothing that PostgreSQL does not already know**.
- **Redis unavailable:** the API stays alive (`/health` 200), reports not ready (`/ready` 503), refuses new deployments with `503` and records them as `FAILED` (never left `QUEUED` without a job), counts rate limits in memory, and live logs fall back to polling PostgreSQL. Workers keep reconnecting and continue with their jobs when Redis returns (tested by killing their connections mid-deployment).

## Audit log

Security-sensitive actions are written to `audit_logs` (who, what, target, IP, request ID, a few non-secret details) and readable through `GET /api/audit-logs?limit=50&before=<id>` (USER: own entries; ADMIN: all):

`auth.register`, `auth.login`, `auth.login_failed`, `auth.logout`, `project.created`, `project.updated` (the fields sent and their new values), **`project.github_changed`** (repository or branch, with old and new values), **`project.aws_changed`** (deployment target, ECS service or service URL, with old and new values), `project.deleted`, `deployment.created`, `deployment.status_changed`, `deployment.log_added`, `webhook.push`, `webhook.rejected`, `access.denied`.

What happens *inside* a deployment (build, health check, rollback triggered and its outcome, timeouts, recovery) is not duplicated: it is already in `deployments` (`rollback_status`, `rollback_deployment_id`, `error_message`, timestamps) and `deployment_logs`. Deployments cannot be cancelled in DeployX, so there is no cancel event. Passwords, tokens and signatures are never passed to the audit log.

## Frontend security

- The dashboard never renders HTML from data (no `dangerouslySetInnerHTML`); React escapes everything. Links come from validated values only (`https://github.com/…` repositories, http(s) service origins).
- Authentication state comes from `GET /api/auth/me`; any `401` returns the dashboard to the sign-in form. No token is stored in the browser (`document.cookie` and `localStorage` stay empty).
- The production build has no inline scripts or styles and runs under a CSP that allows only its own origin. Verified in a browser: sign-in, monitoring, the deployment history and live SSE logs work with no CSP violations.
- No `VITE_*` variables are used; the bundle contains no configuration or secret.
- **Frontend tests** ([`client/test/`](../client/test), Vitest + Testing Library in jsdom, `npm run test:client`): the API client (cookies only, error codes, 401 signs out), signed-out view requests no data, sign-in and registration errors, session expiry and sign-out, nothing stored in the browser, API data rendered as text (an `<img onerror>` project name stays text), the monitoring panel showing real values and "unavailable" instead of zeros, and source scans: no raw HTML, no browser storage, no build-time variables, no tokens in URLs, a CSP without `unsafe-inline` that matches nginx.

## Dependency security

`npm audit` (run 2026-10-13) reports **0 vulnerabilities** for the API and the worker. The dashboard reports **1 high-severity advisory** in `source-map-js` ([GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)), pulled in by jsdom (tests) and by PostCSS inside Vite (build) and not part of the bundle served to browsers; `npm audit fix` in `client/` updates the lockfile. Phase 8 added only established, maintained packages: `helmet`, `express-rate-limit` and `prom-client` (API) and `prom-client` (worker). Password hashing, sessions and logging use Node's standard library. Nothing was upgraded blindly; run `npm audit` in `server/`, `worker/` and `client/` as part of every release.
