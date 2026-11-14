import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRelayRateLimit } from "../lib/relay-rate-limit.ts";
import { GET, POST } from "../app/api/v1/[...path]/route.ts";

const publicOrigin = "https://moon.example";
function request(method: "GET" | "POST", address?: string, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (address) headers.set("x-vercel-forwarded-for", address);
  if (method === "GET") return new Request(publicOrigin + "/api/v1/sites", { headers });
  headers.set("origin", publicOrigin);
  headers.set("content-type", "application/json");
  return new Request(publicOrigin + "/api/v1/compare", { method, headers, body: "{}" });
}
function allowN(limit: ReturnType<typeof createRelayRateLimit>, req: Request, n: number, vercel = true) {
  for (let i = 0; i < n; i++) assert.equal(limit(req, vercel), undefined);
}

test("per-instance network budget counts both methods, reserves reads after the POST limit, and reports an exact wait", async () => {
  let clock = 1_000;
  const limit = createRelayRateLimit(() => clock);
  const post = request("POST", "192.0.2.10"), get = request("GET", "192.0.2.10");
  allowN(limit, post, 10);
  clock += 555;
  const stopped = limit(post, true)!;
  assert.equal(stopped.status, 429);
  assert.equal(stopped.headers.get("retry-after"), "60");
  assert.equal(stopped.headers.get("cache-control"), "no-store");
  assert.equal(stopped.headers.get("content-type"), "application/problem+json");
  const problem = await stopped.json();
  assert.equal(problem.code, "RATE_LIMITED");
  assert.equal(problem.status, 429);
  assert.ok(problem.type && problem.title && problem.hint);
  allowN(limit, get, 230);
  assert.equal(limit(get, true)?.status, 429);
  clock = 60_999;
  assert.equal(limit(post, true)?.headers.get("retry-after"), "1");
  allowN(limit, request("POST", "192.0.2.11"), 10);
  clock = 61_000;
  assert.equal(limit(post, true), undefined);
});

test("only a single trusted, valid address creates an identity; fallback is shared and IPv6 spellings agree", () => {
  const limit = createRelayRateLimit();
  allowN(limit, request("POST", "192.0.2.10"), 10, false);
  for (const address of [undefined, "192.0.2.11,192.0.2.10", "fe80::1%test", "invalid"]) {
    assert.equal(limit(request("POST", address, { "x-real-ip": "203.0.113.10", "x-forwarded-for": "203.0.113.11" }), true)?.status, 429);
  }
  assert.equal(limit(request("POST", "203.0.113.12"), false)?.status, 429);
  const ipv6 = request("POST", "2001:db8::1");
  allowN(limit, ipv6, 10);
  assert.equal(limit(request("POST", "2001:0DB8:0000:0000:0000:0000:0000:0001"), true)?.status, 429);
  assert.equal(limit(request("POST", "2001:db8::2"), true), undefined);
});

test("full client table preserves existing budgets and shares overflow until expired windows release space", () => {
  let clock = 1;
  const limit = createRelayRateLimit(() => clock, 1);
  allowN(limit, request("POST", "192.0.2.1"), 3);
  clock++;
  allowN(limit, request("POST", "192.0.2.2"), 10);
  assert.equal(limit(request("POST", "192.0.2.3"), true)?.status, 429);
  allowN(limit, request("POST", "192.0.2.1"), 7);
  assert.equal(limit(request("POST", "192.0.2.1"), true)?.status, 429);
  clock = 60_001;
  assert.equal(limit(request("POST", "192.0.2.3"), true), undefined);
  assert.equal(limit(request("POST", "192.0.2.4"), true)?.status, 429);
  clock++;
  assert.equal(limit(request("POST", "192.0.2.4"), true), undefined);
});

test("route rejects before upstream; outside hosted Vercel request headers cannot create identities", async t => {
  const names = ["NEXT_PUBLIC_LUNARNAV_PROXY", "LUNARNAV_API_KEY", "VERCEL", "VERCEL_ENV"] as const;
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));
  process.env.NEXT_PUBLIC_LUNARNAV_PROXY = "1";
  process.env.LUNARNAV_API_KEY = randomUUID();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ test: true }); });
  delete process.env.VERCEL;
  process.env.VERCEL_ENV = "production";
  for (let n = 1; n <= 10; n++) assert.equal((await POST(request("POST", "192.0.2." + n))).status, 200);
  assert.equal((await POST(request("POST", "192.0.2.11"))).status, 429);
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "development";
  assert.equal((await POST(request("POST", "192.0.2.12"))).status, 429);
  assert.equal(calls, 10);
  process.env.VERCEL_ENV = "production";
  assert.equal((await POST(request("POST", "192.0.2.13"))).status, 200);
  assert.equal((await GET(request("GET", "192.0.2.13"))).status, 200);
  assert.equal(calls, 12);
});
