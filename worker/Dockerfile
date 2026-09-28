FROM node:22-alpine

# git clones repositories; the Docker CLI (with buildx for BuildKit builds)
# talks to the host's Docker daemon through the socket mounted by Compose.
RUN apk add --no-cache git docker-cli docker-cli-buildx

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production

# Runs as an unprivileged user. Access to the Docker socket comes from the
# socket's group, added in docker-compose.yml (group_add).
USER node
CMD ["node", "src/index.js"]
