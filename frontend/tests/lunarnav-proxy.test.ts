import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { proxyLunarnav } from "../lib/lunarnav-proxy.ts";
import { publicContract } from "../scripts/public-contract.mjs";

const frontend = "https://moon.example";
const freshKey = () => randomUUID();
const request = (path: string, init?: RequestInit) => new Request(frontend + "/api/v1/" + path, init);
const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json", origin: frontend }, body: JSON.stringify(body),
});

test("public integrations pin the producer origin, filter headers and keep source bytes", async () => {
  const key = freshKey();
  for (const path of [
    "runs?limit=1", "sites?run_id=B2&format=geojson", "dataset?site_ids=apollo11&step_s=3600",
    "ranking?weights=pct_sun%3A1", "sites/custom%3A0.0000%3A1.0000/instant?t=2026-11-14T00%3A00%3A00Z",
    "sites/apollo11", "runs/B2", "runs/B2/files/sites%2Fapollo11%2Fwindows.json", "export/summary.csv?run_id=B2",
    "sites/apollo11/export/windows.csv?kinds=both", "sites/apollo11/export/series.csv?fields=both_visible",
  ]) {
    const response = await proxyLunarnav(request(path, { headers: { cookie: "private=client", authorization: "client header" } }), key, async (url, init) => {
      assert.equal(String(url), "https://api.lunavigator.com/api/v1/" + path);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("X-API-Key"), key);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("cookie"), null);
      assert.equal(init?.redirect, "error");
      return new Response("fixture", { headers: { "content-type": path.includes(".csv") ? "text/csv" : "application/json",
        "set-cookie": "sensitive=test", etag: '"fixture"', "x-debug": "private" } });
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "fixture");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-debug"), null);
    assert.equal(response.headers.get("etag"), '"fixture"');
  }
});

test("only the two read-only JSON submissions go upstream", async () => {
  for (const [path, body] of [["compare", { run_id: "B2", site_ids: ["apollo11", "im2_athena"] }],
    ["alt-dates", { site_id: "im2_athena", mission_h: 6, constraints: { objective: "both" } }]] as const) {
    let calls = 0;
    const response = await proxyLunarnav(request(path, post(body)), freshKey(), async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).pathname, "/api/v1/" + path);
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return Response.json({ status: 422, detail: "Model range rejected" }, { status: 422 });
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).detail, "Model range rejected");
  }
});

test("unavailable routes, job operations and disallowed input never reach the authenticated service", async () => {
  for (const [req, status] of [
    [request("jobs", post({ type: "custom_site" })), 404], [request("jobs/j_fixture"), 404],
    [request("jobs/j_fixture", { method: "DELETE" }), 404], [request("admin"), 404],
    [request("openapi.json"), 404], [request("runs/A/files/sites%2F..%2Fprivate"), 404],
    [request("runs/A/files/%252e%252e%252fmissing"), 404], [request("runs/A/files/a%5Cb"), 404],
    [request("runs/A%2Ffiles%2Fmanifest.json"), 404],
    [request("dataset?unknown=value"), 400], [request("runs?limit=1&limit=2"), 400],
    [request("alt-dates", { ...post({}), headers: { origin: "https://foreign.example", "content-type": "application/json" } }), 403],
    [request("compare", { ...post({}), headers: { origin: frontend, "content-type": "text/plain" } }), 415],
    [request("compare", post({ arbitrary: true })), 400],
    [request("alt-dates", post({ site_id: "a".repeat(18_000) })), 413],
  ] as const) {
    let calls = 0;
    const response = await proxyLunarnav(req, freshKey(), async () => { calls++; return Response.json({}); });
    assert.equal(response.status, status, req.url);
    assert.equal(calls, 0);
  }
});

test("missing credentials and upstream authentication errors produce local messages only", async () => {
  const unused = async () => { throw Error("unreachable"); };
  assert.equal((await proxyLunarnav(request("runs"), undefined, unused)).status, 503);
  for (const status of [401, 403, 302]) {
    const response = await proxyLunarnav(request("sites"), freshKey(), async () => new Response("upstream diagnostic", {
      status, headers: { location: "https://unrelated.example/", "www-authenticate": "private" },
    }));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /upstream diagnostic/);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("www-authenticate"), null);
  }
});

test("public Swagger operations match the relay and retain producer parameter definitions", async () => {
  const readJson = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
  const producer = await readJson("../../contracts/openapi.dataset.json");
  const published = await readJson("../public/api-contract/lunarnav.json");
  assert.deepEqual(producer.security, [{ ApiKeyAuth: [] }]);
  assert.equal(producer.components.securitySchemes.ApiKeyAuth.name, "X-API-Key");
  assert.deepEqual(published.security, []);
  const explicitlySecured = structuredClone(producer);
  explicitlySecured.paths["/api/v1/runs"].get.security = [{ ApiKeyAuth: [] }];
  assert.deepEqual(publicContract(explicitlySecured), published);
  assert.equal(published.components.securitySchemes, undefined);
  assert.doesNotMatch(JSON.stringify(published), /x-api-key|www-authenticate|authorization: bearer/i);
  // An accepted route stops at the missing-key check before forwarding anything.
  const forward = async (req: Request) => (await proxyLunarnav(req, undefined)).status === 503;
  for (const [path, methods] of Object.entries(producer.paths)) {
    const concrete = path.replaceAll(/\{[^}]+\}/g, "sample");
    for (const [method, operation] of Object.entries(methods as Record<string, {
      parameters?: { in: string; name: string }[];
      requestBody?: { content: Record<string, { schema: { $ref: string } }> };
    }>)) {
      const methodName = method.toUpperCase();
      const req = (suffix = "") => new Request(frontend + concrete + suffix, { method: methodName });
      const exposed = published.paths[path]?.[method];
      assert.equal(Boolean(exposed), await forward(req()), methodName + " " + path);
      if (!exposed) continue;
      assert.ok(producer.paths[path][method].responses["401"]);
      assert.equal(exposed.security, undefined);
      assert.equal(exposed.responses["401"], undefined);
      assert.ok(exposed.responses["502"].content["application/json"]);
      const allowed = [];
      for (const param of operation.parameters ?? []) {
        if (param.in === "path" || await forward(req("?" + param.name + "=example"))) allowed.push(param);
      }
      assert.deepEqual(exposed.parameters ?? [], allowed);
      if (operation.requestBody) {
        const ref = operation.requestBody.content["application/json"].schema.$ref;
        const name = ref.split("/").at(-1)!;
        assert.deepEqual(published.components.schemas[name], producer.components.schemas[name]);
      }
    }
  }
  assert.equal(published.components.schemas.CreateJobRequest, undefined);
  assert.equal(published.components.schemas.Job, undefined);
});

test("public CSV filenames distinguish site, run, requested UTC bounds and selected columns", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62, 0x0d, 0x0a]);
  async function download(path: string, fields: Record<string, string> = {}) {
    const query = new URLSearchParams(fields);
    const target = path + (query.size ? "?" + query : "");
    const response = await proxyLunarnav(request(target), freshKey(), async url => {
      assert.equal(String(url), "https://api.lunavigator.com/api/v1/" + target);
      return new Response(bytes, { headers: { "content-type": "text/csv",
        "content-disposition": 'attachment; filename="untrusted.csv"' } });
    });
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    return response.headers.get("content-disposition");
  }
  const date = { run_id: "B2", start: "2026-11-14T14:00:00.123456789Z", end: "2026-11-14T15:00:00.500Z" };
  const base = "sites/apollo11/export/";
  for (const [kind, field, selection] of [["series", "fields", "sun_visible"], ["windows", "kinds", "both"]]) {
    const path = base + kind + ".csv", query = { ...date, [field]: selection };
    const original = await download(path, query);
    assert.match(original!, new RegExp('^attachment; filename="' + kind + '~apollo11~B2~2026-11-14T140000\\.123456789Z~2026-11-14T150000\\.500Z~[a-f0-9]{16}\\.csv"$'));
    assert.equal(await download(path, { [field]: selection, end: date.end, run_id: date.run_id, start: date.start }), original);
    for (const changed of [{ ...query, run_id: "B" }, { ...query, start: date.start.replace("789", "788") },
      { ...query, end: date.end.replace("500", "501") }, { ...query, [field]: selection + ",earth" }])
      assert.notEqual(await download(path, changed), original);
    assert.notEqual(await download(path.replace("apollo11", "apollo15"), query), original);
  }
  assert.equal(await download("export/summary.csv", { run_id: "B2" }), 'attachment; filename="summary~B2.csv"');
  assert.equal(await download("export/summary.csv"), 'attachment; filename="summary~@default.csv"');
  assert.notEqual(await download("export/summary.csv", { run_id: "B" }), await download("export/summary.csv", { run_id: "B2" }));
  const unsafe = await download(base + "series.csv", { run_id: '../bad"\r\nX-Test:1', start: "../../bad", end: 'bad";extra=1' });
  assert.match(unsafe!, /^attachment; filename="series~apollo11~@value-[a-f0-9]{16}~@value-[a-f0-9]{16}~@value-[a-f0-9]{16}\.csv"$/);
});

test("original run downloads retain the manifest bytes, ETag and path while qualifying local names", async () => {
  const bytes = new Uint8Array([0x1f, 0x8b, 0, 255]);
  const etag = '"' + createHash("sha256").update(bytes).digest("hex") + '"';
  async function name(run: string, path: string, separate = false) {
    const encoded = encodeURIComponent(path);
    const route = "runs/" + encodeURIComponent(run) + "/files/";
    const res = await proxyLunarnav(request(route + (separate ? encoded.replaceAll("%2F", "/") : encoded)), freshKey(), async url => {
      assert.equal(new URL(String(url)).pathname, "/api/v1/" + route + encoded);
      return new Response(bytes, { headers: { "content-type": "application/octet-stream", etag } });
    });
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
    assert.equal(res.headers.get("etag"), etag);
    const filename = /^attachment; filename="([a-zA-Z0-9_.~+-]+)"$/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    assert.ok(filename);
    assert.ok(Buffer.byteLength(filename) <= 240);
    return filename;
  }
  const file = "horizon_bruteforce.csv";
  const odysseus = await name("B2", "sites/im1_odysseus/" + file);
  const athena = await name("B2", "sites/im2_athena/" + file);
  assert.match(odysseus, /^raw~B2~sites~im1_odysseus~[a-f0-9]{16}~horizon_bruteforce\.csv$/);
  assert.notEqual(odysseus, athena);
  assert.equal(await name("B2", "sites/im2_athena/" + file, true), athena);
  assert.notEqual((await name("b2", "sites/im2_athena/" + file)).toLowerCase(), athena.toLowerCase());
  assert.notEqual(await name("B", "manifest.json"), await name("B2", "manifest.json"));
  assert.match(await name("B2", "sites/custom:1/windows.json"), /~custom\+1~.+~windows\.json$/);
  const longPath = "sites/" + "a".repeat(228) + "/p/" + "b".repeat(240) + ".csv.gz";
  const longName = await name("B2", longPath);
  assert.ok(longName.endsWith(".csv.gz"));
  assert.notEqual(longName, await name("B2", longPath.replace("/p/", "/q/")));
});

test("conditional reads forward bounded validators, accept a matching upstream 304 and preserve download metadata", async () => {
  const match = 'W/"other", "opaque@,value"';
  const tag = 'W/"opaque@,value"';
  const req = request("sites", { headers: { "if-none-match": match, cookie: "private=browser", authorization: "client credential" } });
  const result = await proxyLunarnav(req, freshKey(), async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("if-none-match"), match);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    return new Response(null, { status: 304, headers: { etag: tag, "cache-control": "public, max-age=55", "set-cookie": "x=fake" } });
  });
  assert.equal(result.status, 304);
  assert.equal(result.body, null);
  assert.equal(result.headers.get("content-type"), null);
  assert.equal(result.headers.get("etag"), tag);
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("cache-control"), "private, max-age=55, must-revalidate");

  const path = "runs/B2/files/sites%2Fapollo11%2Fwindows.json";
  const cache = { etag: '"file"', "cache-control": "public, immutable, max-age=3600" };
  const first = await proxyLunarnav(request(path), freshKey(), async () => Response.json({}, { headers: cache }));
  const second = await proxyLunarnav(request(path, { headers: { "if-none-match": "*" } }), freshKey(), async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("if-none-match"), "*");
    return new Response(null, { status: 304, headers: cache });
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 304);
  assert.match(first.headers.get("content-disposition")!, /attachment; filename=/);
  assert.equal(first.headers.get("content-disposition"), second.headers.get("content-disposition"));
  assert.equal(first.headers.get("cache-control"), "private, no-cache");
  assert.equal(second.headers.get("cache-control"), "private, no-cache");
});

test("unmatched, unsolicited and malformed 304 responses are protected; requests that miss still fetch fresh data", async () => {
  for (const [condition, tag, forwarded] of [
    [null, '"current"', null], ['"prior"', '"different"', '"prior"'], ['"prior"', null, '"prior"'],
    ['junk, "current"', '"current"', null], ['*, "current"', '"current"', null],
    [Array(17).fill('"x"').join(","), '"x"', null], ['"' + "a".repeat(1100) + '"', '"current"', null],
  ]) {
    const req = request("sites", { headers: condition ? { "if-none-match": condition } : {} });
    const res = await proxyLunarnav(req, freshKey(), async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("if-none-match"), forwarded);
      return new Response(null, { status: 304, headers: tag ? { etag: tag } : {} });
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  const changed = await proxyLunarnav(request("sites", { headers: { "if-none-match": 'W/"old"' } }), freshKey(),
    async () => Response.json({ updated: true }, { headers: { etag: 'W/"new"', "cache-control": "max-age=10" } }));
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("etag"), 'W/"new"');
  assert.deepEqual(await changed.json(), { updated: true });

  for (const status of [200, 304]) {
    const options = post({});
    const headers = new Headers(options.headers);
    headers.set("if-none-match", '"x"');
    const res = await proxyLunarnav(request("compare", { ...options, headers }), freshKey(), async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("if-none-match"), null);
      return new Response(status === 200 ? "{}" : null, { status, headers: { etag: '"x"', "content-type": "application/json", "cache-control": "public, max-age=300" } });
    });
    assert.equal(res.status, status === 304 ? 502 : 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("only tagged successful reads receive private, capped freshness; upstream age and stricter policies win", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-15T01:01:00Z"));
  async function policy(path: string, control: string | null, extras: Record<string, string> = {}, status = 200) {
    const headers = new Headers({ etag: '"model"', "content-type": "application/json", ...extras });
    if (control !== null) headers.set("cache-control", control);
    return (await proxyLunarnav(request(path), freshKey(), async () => Response.json({}, { status, headers }))).headers.get("cache-control");
  }
  for (const [path, control, extras, ttl] of [
    ["sites", "public, max-age=600", { age: "10" }, 50],
    ["sites?run_id=B2", "public, max-age=9999", { age: "5" }, 3595],
    ["runs/B2", 'private, max-age="120"', { age: "8", date: "Sun, 15 Nov 2026 01:00:30 GMT" }, 90],
    ["runs", "max-age=30", { age: "60" }, 0],
  ] as [string, string, Record<string,string>, number][]) {
    assert.equal(await policy(path, control, extras), `private, max-age=${ttl}, must-revalidate`);
  }
  assert.equal(await policy("sites", "public, no-store, max-age=20"), "no-store");
  assert.equal(await policy("sites", null), "no-store");
  assert.equal(await policy("sites", "max-age=300", { etag: "malformed" }), "no-store");
  assert.equal(await policy("sites", "max-age=300", { vary: "*" }), "no-store");
  for (const control of ["max-age=300, no-cache", "max-age=20, max-age=50", "public, s-maxage=600", "max-age=bad", "no-cache=\"etag\""])
    assert.equal(await policy("sites", control), "private, no-cache");
  for (const extra of [{ age: "invalid" }, { date: "invalid" }] as Record<string,string>[])
    assert.equal(await policy("sites", "max-age=60", extra), "private, no-cache");
  assert.equal(await policy("export/summary.csv", "no-store"), "no-store");
  for (const status of [401, 403, 302, 422, 429, 503]) assert.equal(await policy("sites", "public, max-age=60", {}, status), "no-store");
});
