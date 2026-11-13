// One switch: "mock" for the synthetic demo, or the backend origin. Browser calls stay same-origin.
const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'mock';
let origin;
if (base !== 'mock') {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('NEXT_PUBLIC_API_BASE_URL must be mock or an HTTP(S) origin without credentials or a path.');
  origin = url.origin;
}
export default {
  async rewrites() {
    return { beforeFiles: origin ? [{ source: '/api/:path*', destination: `${origin}/api/:path*` }] : [] };
  },
};
