# DeployX test app: builds fine, but the container exits immediately.
# DeployX must report the deployment as FAILED ("container exited").
#   dockerfile_path: examples/crash-app/Dockerfile
#   container_port:  3000
FROM node:22-alpine

USER node
CMD ["node", "-e", "console.error('crash-app: exiting on purpose'); process.exit(1)"]
