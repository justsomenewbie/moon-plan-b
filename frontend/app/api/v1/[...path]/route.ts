import { proxyLunarnav } from "../../../../lib/lunarnav-proxy.ts";
import { createRelayRateLimit } from "../../../../lib/relay-rate-limit.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rateLimit = createRelayRateLimit();

function forward(request: Request) {
  if (process.env.NEXT_PUBLIC_LUNARNAV_PROXY !== "1") return new Response(null, { status: 404 });
  const onVercel = process.env.VERCEL === "1" && (process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview");
  return rateLimit(request, onVercel) ?? proxyLunarnav(request, process.env.LUNARNAV_API_KEY);
}

export { forward as GET, forward as POST };
