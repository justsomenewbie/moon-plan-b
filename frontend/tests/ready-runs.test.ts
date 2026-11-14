import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../lib/api/client.ts";
import { getReadyModelRuns } from "../lib/api/planner.ts";

const start = "2026-01-01T00:00:00Z", end = "2026-01-02T00:00:00Z";
function run(id: string) {
  return { run_id: id, kind: "precompute", status: "ready", label: "Release " + id, provider: "test provider", dem: "test terrain",
    is_default: id === "release-0", start_utc: start, end_utc: end, step_s: 3600, n_samples: 24, n_sites: 2, site_ids: ["first", "second"] };
}
const page = (rows: unknown[], total = rows.length, offset = 0) => ({ default_run_id: "release-0", limit: 20, total, offset, runs: rows });

test("requests only ready precomputed releases, preserves producer order and distinguishes pages from defaults", async t => {
  const calls: string[] = [], items = Array.from({ length: 21 }, (_, i) => run("release-" + i));
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    const url = new URL(req.url), offset = Number(url.searchParams.get("offset"));
    assert.deepEqual(Object.fromEntries(url.searchParams), { kind: "precompute", status: "ready", limit: "20", offset: String(offset) });
    calls.push(url.pathname);
    return Response.json(page(items.slice(offset, offset + 20), items.length, offset));
  });
  const first = await getReadyModelRuns(0), second = await getReadyModelRuns(20), empty = await getReadyModelRuns(40);
  assert.deepEqual([first.total, first.offset, first.limit, first.runs.length], [21, 0, 20, 20]);
  assert.deepEqual(first.runs[0], { runId: "release-0", label: "Release release-0", provider: "test provider", dem: "test terrain",
    isDefault: true, start, end, stepSeconds: 3600, siteCount: 2 });
  assert.deepEqual(first.runs.map(r => r.runId), items.slice(0, 20).map(r => r.run_id));
  assert.deepEqual([second.total, second.offset, second.runs.length, second.runs[0].runId, second.runs[0].isDefault], [21, 20, 1, "release-20", false]);
  assert.deepEqual(empty.runs, []);
  assert.deepEqual(calls, Array(3).fill("/api/v1/runs"));
});

test("unknown source metadata displays safely, independently of release usability", async t => {
  const first = { ...run("release-0"), label: {}, provider: "  Future source Ω ", dem: "x".repeat(300), code_version: null };
  const second = { ...run("other"), label: "Run\nTitle", provider: null, dem: "new DEM" };
  t.mock.method(globalThis, "fetch", async () => Response.json(page([first, second])));
  const { runs } = await getReadyModelRuns(0);
  assert.deepEqual(runs.map(r => [r.label, r.provider, r.dem]), [["release-0", "Future source Ω", undefined], ["other", undefined, "new DEM"]]);
});

test("rejects inconsistent pagination, unsuitable entries, duplicates and invalid native grids", async t => {
  const good = run("release-0"), goodPage = page([good]);
  const malformed = [
    null, { ...goodPage, limit: 50 }, { ...goodPage, offset: 1 }, { ...goodPage, total: 2 }, { ...goodPage, total: 0 },
    { ...goodPage, total: -1 }, { ...goodPage, total: 1.5 }, { ...goodPage, runs: null }, { ...goodPage, default_run_id: ".." },
    page([good, good]), page([null]), page([{ ...good, is_default: false }]), page([{ ...good, kind: "custom" }]),
    page([{ ...good, status: "importing" }]), page([{ ...good, status: "failed" }]), ...[".", "..", "bad/run", "a".repeat(65)].map(runId => page([run(runId)])),
    page([{ ...good, start_utc: "2026-02-30T00:00:00Z" }]), page([{ ...good, end_utc: start }]),
    page([{ ...good, step_s: 0 }]), page([{ ...good, n_samples: 25 }]), page([{ ...good, n_sites: 3 }]),
    page([{ ...good, site_ids: ["first", "first"] }]), page([{ ...good, site_ids: ["first", null] }]),
  ];
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  for (payload of malformed) await assert.rejects(getReadyModelRuns(0), (e: unknown) => e instanceof ApiError && e.status === 502);
});

test("validates offsets before fetch and propagates cancellation and upstream problem details", async t => {
  const controller = new AbortController(), pending = new AbortController();
  controller.abort();
  let n = 0;
  t.mock.method(globalThis, "fetch", async () => {
    n++;
    if (n === 1) return Response.json({ type: "about:blank", title: "Unavailable", status: 503, code: "BACKEND_DOWN", detail: "Model imports paused." }, { status: 503 });
    pending.abort();
    return Response.json(page([run("release-0")]));
  });
  for (const offset of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(getReadyModelRuns(offset), (e: unknown) => e instanceof ApiError && e.status === 400);
  await assert.rejects(getReadyModelRuns(0, controller.signal), { name: "AbortError" });
  assert.equal(n, 0);
  await assert.rejects(getReadyModelRuns(0), (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === "BACKEND_DOWN" && e.message === "Model imports paused.");
  await assert.rejects(getReadyModelRuns(0, pending.signal), { name: "AbortError" });
  assert.equal(n, 2);
});
