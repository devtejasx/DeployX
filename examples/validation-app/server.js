// Phase 9 validation app. Its behaviour comes from version.json, so every
// scenario is a real commit pushed to GitHub:
//   healthy     GET /health -> 200
//   unhealthy   GET /health -> 503
//   hang        GET /health never answers (health-check timeout)
//   crash       exits right after starting (container startup failure)
//   build-fail  the Docker build itself fails (see Dockerfile)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const { version, mode } = JSON.parse(readFileSync(new URL('./version.json', import.meta.url), 'utf8'));
const port = Number(process.env.PORT) || 3000;

if (mode === 'crash') {
  console.error(`validation-app ${version}: crashing on purpose`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'validation-app', version, mode }) + '\n');
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    if (mode === 'hang') return; // never answers
    const healthy = mode === 'healthy';
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', version }) + '\n');
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => console.log(`validation-app ${version} (${mode}) listening on ${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
