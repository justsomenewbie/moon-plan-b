import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

const windowMs = 60_000;
const maxRequests = 240;
const maxPosts = 10;
const maxClients = 4096;
type Budget = { expires: number; requests: number; posts: number };

// Vercel supplies this header on hosted requests. Other hosts and local development
// have no trusted client identity and use a single shared budget.
function clientAddress(headers: Headers, onVercel: boolean) {
  if (!onVercel) return null;
  const value = headers.get("x-vercel-forwarded-for");
  if (!value || value.length > 45 || value.includes("%")) return null;
  const version = isIP(value);
  if (version === 4) return value;
  return version === 6 ? new URL("http://[" + value + "]").hostname : null;
}

export function createRelayRateLimit(now: () => number = Date.now, capacity = maxClients) {
  const key = randomBytes(32);
  const clients = new Map<string, Budget>();
  let fallback: Budget | undefined;
  let overflow: Budget | undefined;
  const fresh = (time: number): Budget => ({ expires: time + windowMs, requests: 0, posts: 0 });

  return function limit(request: Request, onVercel: boolean): Response | undefined {
    const time = now();
    // A window's expiry never changes, so insertion order is also expiration order.
    for (const [id, budget] of clients) {
      if (budget.expires > time) break;
      clients.delete(id);
    }
    const address = clientAddress(request.headers, onVercel);
    let budget: Budget;
    if (!address) {
      if (!fallback || fallback.expires <= time) fallback = fresh(time);
      budget = fallback;
    } else {
      const id = createHmac("sha256", key).update(address).digest("hex");
      const known = clients.get(id);
      if (known) budget = known;
      else if (clients.size < capacity) {
        budget = fresh(time);
        clients.set(id, budget);
      } else {
        // Preserve active clients' budgets; new arrivals share this window until space opens.
        if (!overflow || overflow.expires <= time) overflow = fresh(time);
        budget = overflow;
      }
    }

    const post = request.method === "POST";
    if (budget.requests >= maxRequests || (post && budget.posts >= maxPosts)) {
      const seconds = Math.max(1, Math.ceil((budget.expires - time) / 1000));
      return Response.json({
        type: "urn:moon-plan-b:relay:rate-limited", title: "Too many requests", status: 429, code: "RATE_LIMITED",
        detail: "This network reached the public frontend's request limit.",
        hint: "Wait for the indicated retry time or open the saved data.",
      }, { status: 429, headers: { "content-type": "application/problem+json", "cache-control": "no-store", "retry-after": String(seconds) } });
    }
    budget.requests++;
    if (post) budget.posts++;
  };
}
