/**
 * Snippet for the Next.js app's next.config.ts: proxy /api/v1/* to the backend (same origin -> no CORS).
 *
 *   dev:  API_INTERNAL_URL=http://127.0.0.1:3000   (backend `npm run dev`)
 *         API_INTERNAL_URL=http://127.0.0.1:4010   (Prism mock `npm run mock`)
 *   prod on the VPS: prefer letting Caddy route /api/* straight to the backend (backend/deploy/Caddyfile);
 *         then this rewrite is never hit, and the backend sees the real client IP for rate limiting.
 *
 * Merge `rewrites` into your existing config if you already have one.
 *
 * API KEYS: a rewrite cannot add the X-API-Key header, so against a backend with API_KEYS set (production,
 * https://api.lunavigator.com) the browser goes through the route handler src/app/api/lunar/[...path]/route.ts
 * instead (the default of src/lib/api/client.ts). Keep these rewrites only for a keyless backend (local dev
 * server without API_KEYS, Prism mock); /docs needs the backend's DOCS_USER / DOCS_PASSWORD when set.
 */
import type { NextConfig } from 'next';

const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3000';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` },
      // Optional: the backend's Swagger UI under the FE origin.
      { source: '/docs/:path*', destination: `${API_ORIGIN}/docs/:path*` },
    ];
  },
};

export default nextConfig;
