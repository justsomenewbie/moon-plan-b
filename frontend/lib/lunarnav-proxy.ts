// Server-side relay for the public team's authenticated data service.
import { BodyLimitError, readBoundedJson } from "./guide-chat.ts";
import { publicRoute } from "./lunarnav-scope.ts";

const origin = "https://api.lunavigator.com";

function problem(status: number, detail: string) {
  return Response.json({ status, detail }, { status, headers: { "cache-control": "no-store" } });
}

export async function proxyLunarnav(request: Request, key: string | undefined, send: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  let match;
  try { match = publicRoute(url.pathname, request.method); } catch { return problem(400, "Invalid API path."); }
  if (!match) return problem(404, "This endpoint is unavailable in the public frontend.");
  if (url.search.length > 8192 || [...url.searchParams.keys()].some(k => !(match.query as string[]).includes(k) || url.searchParams.getAll(k).length !== 1))
    return problem(400, "Unsupported or repeated query parameter.");
  if (!key) return problem(503, "The public team API is not configured on this server.");
  const headers = new Headers({ "X-API-Key": key, accept: "*/*" });
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(match.body ? 35000 : 30000)]);
  let body: string | undefined;
  if (match.body) {
    const clientOrigin = request.headers.get("origin");
    let client;
    try { client = new URL(clientOrigin ?? ""); } catch { return problem(403, "Same-origin request required."); }
    if (!["http:", "https:"].includes(client.protocol) || client.origin !== clientOrigin ||
        client.host !== (request.headers.get("host") ?? url.host) || request.headers.get("sec-fetch-site") === "cross-site")
      return problem(403, "Same-origin request required.");
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      return problem(415, "Send a JSON query.");
    try {
      const input = await readBoundedJson(request, 16384, deadline);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !match.body!.includes(k)))
        return problem(400, "Unsupported query body.");
      body = JSON.stringify(input);
    } catch (error) {
      return problem(error instanceof BodyLimitError ? 413 : deadline.aborted ? 408 : 400, "Invalid or incomplete JSON query.");
    }
    headers.set("content-type", "application/json");
  }
  let upstream: Response;
  try {
    upstream = await send(origin + "/api/v1/" + match.path + url.search, {
      method: request.method, headers, body, cache: "no-store", redirect: "error", signal: deadline,
    });
  } catch {
    return problem(deadline.aborted ? 504 : 502, "The public team API could not complete this request.");
  }
  const type = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const json = type === "application/json" || type === "application/problem+json" || type === "application/geo+json";
  const file = match.path.includes("/files/");
  const download = file || match.path.endsWith(".csv");
  const binary = ["application/gzip", "application/x-gzip", "application/octet-stream"].includes(type ?? "");
  if (upstream.status === 401 || upstream.status === 403 || (upstream.status >= 300 && upstream.status < 400) ||
      !(json || (download && (type === "text/csv" || type === "application/csv" || binary)))) {
    await upstream.body?.cancel();
    return problem(502, "The public team API did not return an authorized data response.");
  }
  const outgoing = new Headers({ "content-type": type!, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  for (const name of ["etag", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  if (download && upstream.ok) {
    const filename = decodeURIComponent(match.path).split("/").at(-1);
    outgoing.set("content-disposition", `attachment; filename="${filename}"`);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outgoing });
}
