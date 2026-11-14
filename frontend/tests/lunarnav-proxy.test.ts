import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { proxyLunarnav } from "../lib/lunarnav-proxy.ts";

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
  assert.equal(await download("runs/B2/files/sites%2Fapollo11%2Fhorizon.csv"), 'attachment; filename="horizon.csv"');
  const unsafe = await download(base + "series.csv", { run_id: '../bad"\r\nX-Test:1', start: "../../bad", end: 'bad";extra=1' });
  assert.match(unsafe!, /^attachment; filename="series~apollo11~@value-[a-f0-9]{16}~@value-[a-f0-9]{16}~@value-[a-f0-9]{16}\.csv"$/);
});
