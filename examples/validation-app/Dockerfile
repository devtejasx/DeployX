# Phase 9 validation app (build context: the repository root). Deploy it with
#   dockerfile_path: examples/validation-app/Dockerfile   container_port: 3000
# and change version.json to choose what each deployed version does.
FROM node:22-alpine
WORKDIR /app
COPY examples/validation-app/server.js examples/validation-app/version.json ./
RUN node -e "if (require('./version.json').mode === 'build-fail') { console.error('build-fail requested by version.json'); process.exit(1) }"
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
