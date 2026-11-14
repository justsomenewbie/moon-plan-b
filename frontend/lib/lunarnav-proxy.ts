// Server-side relay for the public team's authenticated data service.
import { createHash } from "node:crypto";
import { BodyLimitError, readBoundedJson } from "./guide-chat.ts";
import { publicRoute } from "./lunarnav-scope.ts";

const origin = "https://api.lunavigator.com";

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function attachmentName(path: string, query: URLSearchParams) {
  const parts = decodeURIComponent(path).split("/");
  const basename = parts.at(-1)!;
  if (path.startsWith("runs/")) {
    // publicRoute accepts ASCII path segments. Keep the original suffix for file associations.
    // The digest distinguishes case-only names on macOS and names shortened to fit one component.
    const prefix = ["raw", parts[1], ...parts.slice(3, -1)].join("~").replaceAll(":", "+");
    const tail = "~" + fingerprint(path) + "~" + basename.replaceAll(":", "+").slice(-128);
    return prefix.slice(0, 240 - tail.length) + tail;
  }

  // Only contract-shaped values are printed literally. Keep the original request untouched.
  const part = (value: string | null, pattern: RegExp, omitted: string) => value === null ? omitted
    : pattern.test(value) ? value.replaceAll(":", "") : "@value-" + fingerprint(value);
  const run = part(query.get("run_id"), /^[A-Za-z0-9_.-]{1,64}$/, "@default");
  if (basename === "summary.csv") return "summary~" + run + ".csv";
  const kind = basename.slice(0, -4);
  const name = [kind, parts[1].replaceAll(":", "+"), run,
    part(query.get("start"), utcPattern, "@start"), part(query.get("end"), utcPattern, "@end")];
  const projection = query.get(kind === "series" ? "fields" : "kinds");
  if (projection !== null) name.push(fingerprint(projection));
  return name.join("~") + ".csv";
}

function problem(status: number, detail: string) {
  return Response.json({ status, detail }, { status, headers: { "cache-control": "no-store" } });
}

// Match complete HTTP entity tags, including commas inside quoted tags. Reject the
// whole condition if malformed rather than forwarding a partially parsed validator.
const tagSource = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
const tagPattern = new RegExp(tagSource, "g");
const oneTag = new RegExp("^" + tagSource + "$");
const tagList = new RegExp("^" + tagSource + "(?:[ \\t]*,[ \\t]*" + tagSource + ")*$");
function validators(raw: string | null): string[] {
  if (!raw || raw.length > 1024) return [];
  if (raw === "*") return ["*"];
  if (!tagList.test(raw)) return [];
  const tags = raw.match(tagPattern)!;
  return tags.length <= 16 ? tags : [];
}

function entityTag(value: string | null) {
  if (!value || value.length > 1024) return null;
  return oneTag.test(value) ? value : null;
}

function privateCachePolicy(headers: Headers, pinned: boolean, download: boolean) {
  const raw = headers.get("cache-control");
  if (!raw || raw.length > 1024 || headers.get("vary")?.split(",").some(name => name.trim() === "*")) return "no-store";
  const directives = raw.toLowerCase().split(",").map(d => d.trim());
  if (directives.some(d => /^no-store\b/.test(d))) return "no-store";
  if (download || directives.some(d => /^no-cache\b/.test(d))) return "private, no-cache";
  const lifetimes = directives.filter(d => /^max-age\b/.test(d));
  if (lifetimes.length !== 1) return "private, no-cache";
  const lifetime = /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/.exec(lifetimes[0]);
  if (!lifetime) return "private, no-cache";
  // Only known producer policies grant freshness. The outgoing policy always
  // requires a fresh validation before a stale response can be used.
  const standard = ["public", "private", "must-revalidate", "proxy-revalidate", "immutable", "no-transform"];
  for (const directive of directives) {
    if (directive === lifetimes[0] || standard.includes(directive)) continue;
    if (!/^(s-maxage|stale-if-error|stale-while-revalidate)=\d+$/.test(directive)) return "private, no-cache";
  }
  const age = headers.get("age") ?? "0";
  const date = headers.get("date");
  if (!/^\d+$/.test(age) || (date !== null && !Number.isFinite(Date.parse(date)))) return "private, no-cache";
  const apparentAge = date ? Math.max(0, Math.ceil((Date.now() - Date.parse(date)) / 1000)) : 0;
  const seconds = Math.min(pinned ? 3600 : 60, Number(lifetime[1] ?? lifetime[2]));
  const remaining = Math.max(0, seconds - Math.max(Number(age), apparentAge));
  return `private, max-age=${remaining}, must-revalidate`;
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
  const conditional = request.method === "GET" ? validators(request.headers.get("if-none-match")) : [];
  if (conditional.length) headers.set("if-none-match", conditional.join(", "));
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
  const tag = entityTag(upstream.headers.get("etag"));
  const unchanged = upstream.status === 304;
  const taggedGet = request.method === "GET" && tag !== null && (upstream.status === 200 || unchanged);
  const matched = unchanged && taggedGet && conditional.some(prior => prior === "*" || prior.replace(/^W\//, "") === tag.replace(/^W\//, ""));
  const binary = ["application/gzip", "application/x-gzip", "application/octet-stream"].includes(type ?? "");
  const validContent = json || (download && (type === "text/csv" || type === "application/csv" || binary));
  const redirect = upstream.status >= 300 && upstream.status < 400;
  if (upstream.status === 401 || upstream.status === 403 || (!matched && (redirect || !validContent))) {
    await upstream.body?.cancel();
    return problem(502, "The public team API did not return an authorized data response.");
  }
  const outgoing = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  if (!unchanged) outgoing.set("content-type", type!);
  if (taggedGet) {
    const pinned = Boolean(url.searchParams.get("run_id")) || match.path.startsWith("runs/");
    outgoing.set("etag", tag);
    outgoing.set("cache-control", privateCachePolicy(upstream.headers, pinned, download));
  }
  const retry = upstream.headers.get("retry-after");
  if (retry) outgoing.set("retry-after", retry);
  if (download && (upstream.ok || matched)) {
    const filename = attachmentName(match.path, url.searchParams);
    outgoing.set("content-disposition", `attachment; filename="${filename}"`);
  }
  return new Response(unchanged ? null : upstream.body, { status: upstream.status, headers: outgoing });
}
