# Two images from one file:
#
#   development (Docker Compose): the Vite dev server, which proxies /api to
#     the API container (API_PROXY_TARGET).
#   production: the built dashboard on unprivileged nginx with a strict
#     Content-Security-Policy, proxying /api to API_UPSTREAM.
#       docker build --target production -t deployx-client ./client
#       docker run -p 8080:8080 -e API_UPSTREAM=http://api:5000 deployx-client

# ---- development ----------------------------------------------------------
FROM node:22-alpine AS development

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

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- production -----------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS production
ENV API_UPSTREAM=http://server:5000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
