# DeployX test app: builds and keeps running, but GET /health returns 503.
# DeployX must report the deployment as FAILED and roll back to the last
# stable deployment of the project, if there is one.
#   github_repo:     https://github.com/devtejasx/DeployX
#   dockerfile_path: examples/unhealthy-app/Dockerfile
#   container_port:  3000
# The build context is the repository root; Dockerfile.dockerignore next to
# this file limits it to the files this image needs.
FROM node:22-alpine

WORKDIR /app
COPY examples/unhealthy-app/server.js ./server.js

ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
