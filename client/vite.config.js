import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard calls the API with relative /api URLs. In development Vite
// proxies them to the Express server, so no API URL is baked into the bundle.
// Docker Compose sets API_PROXY_TARGET to the server container.
const apiTarget = process.env.API_PROXY_TARGET || 'http://localhost:5000';

// Security headers of the built dashboard (`vite preview`, and the same in
// nginx.conf.template for the production image). The bundle has no inline
// scripts or styles and talks only to its own origin, so the policy allows
// nothing else. The dev server does not send it: Vite's hot reload injects
// an inline script.
export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

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
  // Frontend tests (npm test): components and API helpers in a simulated DOM.
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{js,jsx}'],
    restoreMocks: true,
  },
  preview: {
    port: 3000,
    headers: SECURITY_HEADERS,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
