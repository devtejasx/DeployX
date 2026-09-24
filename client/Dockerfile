# Development image: runs the Vite dev server, which also proxies /api to the
# API container (API_PROXY_TARGET). A production static build comes later.
FROM node:22-alpine

# Vite writes temp files next to its config and a cache in node_modules/.vite,
# so the app directory must belong to the unprivileged user.
WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .

EXPOSE 3000

CMD ["npx", "vite"]
