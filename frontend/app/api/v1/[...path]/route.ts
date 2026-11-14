import { proxyLunarnav } from "../../../../lib/lunarnav-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function forward(request: Request) {
  if (process.env.NEXT_PUBLIC_LUNARNAV_PROXY !== "1") return new Response(null, { status: 404 });
  return proxyLunarnav(request, process.env.LUNARNAV_API_KEY);
}

export { forward as GET, forward as POST };
