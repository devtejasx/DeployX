import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard calls the API with relative /api URLs. In development Vite
// proxies them to the Express server, so no API URL is baked into the bundle.
// Docker Compose sets API_PROXY_TARGET to the server container.
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:5000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    port: 3000,
  },
});
