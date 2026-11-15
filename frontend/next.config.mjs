// One switch: "mock" for the synthetic demo, or the backend origin. Browser calls stay same-origin.
import { producerTimeoutMs } from './lib/producer-deadline.ts';
const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'mock';
let origin;
if (base !== 'mock') {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('NEXT_PUBLIC_API_BASE_URL must be mock or an HTTP(S) origin without credentials or a path.');
  if (url.hostname === 'api.lunavigator.com' && url.origin !== 'https://api.lunavigator.com') throw new Error('The public team API requires its HTTPS origin.');
  origin = url.origin;
}
const publicTeamApi = origin === 'https://api.lunavigator.com';
export default {
  ...(origin && !publicTeamApi ? { experimental: { proxyTimeout: producerTimeoutMs } } : {}),
  env: { NEXT_PUBLIC_LUNARNAV_PROXY: publicTeamApi ? '1' : '0' },
  poweredByHeader: false,
  // Pictures in public/ are not fingerprinted: cache them for 30 days and give a changed picture a new file name.
  // (/_next/static is already immutable for a year.) deploy-notes/nginx-perf.conf sets the same policy at the proxy.
  async headers() {
    return [{ source: '/:folder(images|brand|team)/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, stale-while-revalidate=86400' }] }];
  },
  async rewrites() {
    if (publicTeamApi) return { beforeFiles: [{ source: '/api/v1/openapi.json', destination: '/api-contract/lunarnav.json' }] };
    return { beforeFiles: origin ? [{ source: '/api/:path*', destination: `${origin}/api/:path*` }] : [] };
  },
};
