# DeployX test apps

Small apps used to test the Docker deployment pipeline (Phase 4) and health checks with automatic rollback (Phase 6). This public repository doubles as the **test repository**: create a DeployX project pointing at `https://github.com/devtejasx/DeployX` and pick an app with `dockerfile_path`. The build context is always the repository root.

| App | `dockerfile_path` | `container_port` | Expected result |
| --- | ----------------- | ---------------- | --------------- |
| [hello-app](hello-app) | `examples/hello-app/Dockerfile` | `3000` | `SUCCESS`; `GET /` returns `Hello from DeployX`, `GET /health` returns `200` |
| [unhealthy-app](unhealthy-app) | `examples/unhealthy-app/Dockerfile` | `3000` | the container keeps running, but `GET /health` returns `503`, so `FAILED` (and a rollback to the last stable deployment, if there is one) |
| [crash-app](crash-app) | `examples/crash-app/Dockerfile` | `3000` | image builds, container exits, so `FAILED` |
| [broken-dockerfile](broken-dockerfile) | `examples/broken-dockerfile/Dockerfile` | `3000` | `docker build` fails, so `FAILED` |
| (none) | `examples/does-not-exist/Dockerfile` | `3000` | `Dockerfile not found`, so `FAILED` |

Each Dockerfile has a `Dockerfile.dockerignore` next to it, so the build context sent to Docker contains only the files that app needs, not the whole repository.

```bash
curl -X POST http://localhost:5000/api/projects -H "Content-Type: application/json" -d '{
  "name": "hello-app",
  "github_repo": "https://github.com/devtejasx/DeployX",
  "github_branch": "main",
  "dockerfile_path": "examples/hello-app/Dockerfile",
  "container_port": 3000
}'
```

DeployX checks each app on the project's `health_check_path`, which defaults to `/health`.

## Trying a rollback

Deploy `hello-app` first, so the project has a stable deployment. Then point the same project at `unhealthy-app` and deploy again:

```bash
curl -X PUT http://localhost:5000/api/projects/<projectId> -H "Content-Type: application/json" \
  -d '{ "dockerfile_path": "examples/unhealthy-app/Dockerfile" }'
curl -X POST http://localhost:5000/api/projects/<projectId>/deployments -H "Content-Type: application/json" -d '{}'
```

The second deployment fails its health check, ends as `FAILED` with `rollback_status: "COMPLETED"`, and `hello-app` keeps answering on its port. Deployed as a project's **first** deployment, `unhealthy-app` ends as `FAILED` with `rollback_status: "NOT_AVAILABLE"`: there is no stable deployment to go back to. See "Phase 6 — Health Checks & Automatic Rollback" in the main [README](../README.md).
