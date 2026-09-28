// Minimal app used to test DeployX deployments: GET / -> "Hello from DeployX".
import http from 'node:http';

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Hello from DeployX\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
});

server.listen(port, () => {
  console.log(`hello-app listening on port ${port}`);
});

// Stop quickly when DeployX replaces or removes the container.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
