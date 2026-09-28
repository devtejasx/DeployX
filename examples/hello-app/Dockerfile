# DeployX test app. Deploy it with:
#   github_repo:     https://github.com/devtejasx/DeployX
#   dockerfile_path: examples/hello-app/Dockerfile
#   container_port:  3000
# The build context is the repository root; Dockerfile.dockerignore next to
# this file limits it to the files this image needs.
FROM node:22-alpine

WORKDIR /app
COPY examples/hello-app/server.js ./server.js

ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
