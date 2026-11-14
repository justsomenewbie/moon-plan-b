/**
 * Client identity for per-client limits and job ownership (no accounts in v1): the request IP as seen
 * by Fastify (`trustProxy: 'loopback'` -> X-Forwarded-For from Caddy on the same host). IPv6 clients
 * are grouped by their /64 (one host usually owns a whole /64, so per-address limits would be trivial
 * to dodge); IPv4-mapped IPv6 (`::ffff:1.2.3.4`) counts as the IPv4 address.
 */
import { isIPv4, isIPv6 } from 'node:net';

/** Expand an IPv6 address to 8 hextets (lower case, no zone id). null when it is not IPv6. */
export function expandIPv6(ip: string): string[] | null {
  const bare = ip.split('%')[0] ?? ip;
  if (!isIPv6(bare)) return null;
  let s = bare.toLowerCase();
  // embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4)
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const h = head.length > 0 ? head.split(':') : [];
  const t = tail === undefined ? [] : tail.length > 0 ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const all = [...h, ...Array.from({ length: fill }, () => '0'), ...t];
  if (all.length !== 8) return null;
  return all.map((x) => x.padStart(4, '0'));
}

/**
 * Client key of a request for per-client limits and job ownership: the API-key client name when the
 * request was authenticated (lib/auth.ts sets req.apiClient), else the IP key. With a server-side FE proxy
 * every end user arrives from the FE server's IP(s) - and serverless hosts change their egress IP - so
 * keying by the API key keeps job ownership (DELETE, JOB_NOT_YOURS) and the job/SSE/storage quotas stable.
 */
export function requestClientKey(req: { apiClient?: string | undefined; ip?: string | undefined }): string {
  return req.apiClient !== undefined && req.apiClient.length > 0 ? `key:${req.apiClient}` : clientKey(req.ip);
}

/** Stable key of the client behind `ip` (IPv4 address, or `<first 4 hextets>::/64` for IPv6). */
export function clientKey(ip: string | undefined): string {
  if (ip === undefined || ip.length === 0) return 'unknown';
  if (isIPv4(ip)) return ip;
  const hx = expandIPv6(ip);
  if (!hx) return ip;
  // IPv4-mapped: ::ffff:a.b.c.d
  if (hx.slice(0, 5).every((x) => x === '0000') && hx[5] === 'ffff') {
    const n = (parseInt(hx[6] ?? '0', 16) << 16) | parseInt(hx[7] ?? '0', 16);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  if (hx.every((x, i) => (i < 7 ? x === '0000' : x === '0001'))) return '::1';
  return `${hx.slice(0, 4).join(':')}::/64`;
}
