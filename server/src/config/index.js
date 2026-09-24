import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the repository-root .env when running outside Docker. Docker Compose
// injects variables directly, so a missing file is expected there.
const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');
try {
  process.loadEnvFile(rootEnvPath);
} catch {
  // No .env file - rely on the process environment.
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
};

export default config;
