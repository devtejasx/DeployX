// App used to test DeployX health checks and automatic rollback: it starts and
// keeps running, but reports itself unhealthy.
//   GET /        -> 200 "unhealthy-app is running"
//   GET /health  -> 503 {"status":"unhealthy"}
import http from 'node:http';

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('unhealthy-app is running\n');
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"status":"unhealthy"}\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
});

server.listen(port, () => {
  console.log(`unhealthy-app listening on port ${port} (GET /health returns 503)`);
});

// Stop quickly when DeployX removes the container.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
