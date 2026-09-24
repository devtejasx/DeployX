import app from './app.js';
import config from './config/index.js';

const server = app.listen(config.port, () => {
  console.log(`[api] DeployX API listening on port ${config.port} (${config.env})`);
});

function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
