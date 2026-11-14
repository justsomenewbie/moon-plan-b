import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { askGuide, GuideRequestError, parseGuideReply, savedGuideContext, workspaceGuideContext } from "../lib/api/guide-chat.ts";
import { parseTerrainSummary } from "../lib/api/terrain-summary.ts";
import { validateDataset } from "../lib/dataset.ts";
import { terrainFixture } from "../../qa/browser-terrain-fixture.mjs";

const normal = validateDataset(JSON.parse(readFileSync(new URL("../../qa/fixtures/normal.json", import.meta.url), "utf8")));

test("saved selections include the exact dated model summary and run", () => {
  const start = "2026-11-14T00:00:00Z";
  const { rows, kind } = savedGuideContext(start);
  assert.equal(kind, "saved");
  assert.deepEqual(rows.map(r => [r.site, r.sunHours, r.earthHours, r.bothHours]), [
    ["Odysseus · IM-1", 33, 168, 33], ["Athena · IM-2", 139, 168, 139],
  ]);
  assert.equal(rows[0].source, "B_spice_pgda_bruteforce_2026_2030");
  assert.equal(rows[0].to, "2026-11-21T00:00:00Z");
  assert.deepEqual(savedGuideContext("im1_odysseus").rows.map(r => r.bothHours), [33, 168]);
  assert.deepEqual(savedGuideContext("other"), { kind: "unavailable", rows: [] });
});

test("scenario summary sums multiple overlaps and keeps incomplete metrics unknown", () => {
  const scenario = structuredClone(normal.scenarios[0]);
  const hour = (h: number) => new Date(Date.parse(scenario.startUtc) + h * 3_600_000).toISOString();
  scenario.intervals!.simultaneous = [[0, 1], [2, 4]].map(([a, b]) => ({ startUtc: hour(a), endUtc: hour(b), endClipped: false }));
  scenario.metrics!.simultaneousLongestHours = 2;
  const partial = { ...normal.scenarios[1], coverage: "partial" as const, metrics: null, intervals: null };
  const result = workspaceGuideContext(null, normal, scenario, partial);
  assert.equal(result.kind, "synthetic");
  assert.deepEqual(result.rows.map(r => r.bothHours), [3, null]);
  assert.equal(result.rows[1].sunHours, null);
  assert.equal(result.rows[0].source, normal.datasetId);
  assert.equal(Object.keys(result.rows[0]).length, 7);
  assert.equal(workspaceGuideContext(null, { ...normal, evidence: "computed-ephemeris" }, scenario).kind, "scenario");
  for (const datasetId of ["https://example.com/private", "www.example.com", "x".repeat(201), "file #5"]) {
    assert.equal(workspaceGuideContext(null, { ...normal, datasetId }, scenario).kind, "unavailable");
  }
});

test("terrain summaries use evaluated UTC bounds and selected site for large files", () => {
  const start = "2026-01-01T00:00:00Z", end = "2026-01-01T04:00:00Z";
  const raw = terrainFixture({ run: "test-run", start, at: "2026-01-01T02:00:00Z", end });
  raw.range.requested_start = "2025-12-31T23:00:00Z";
  const terrain = parseTerrainSummary(raw);
  const partial = workspaceGuideContext(terrain, null);
  assert.deepEqual(partial.rows[0], { site: "im1_odysseus", source: "test-run", from: start, to: end, sunHours: null, earthHours: null, bothHours: null });
  const many = Array.from({ length: 9 }, (_, i) => ({ ...terrain.sites[0], name: "Region " + i }));
  const selected = workspaceGuideContext({ ...terrain, sites: many }, null, undefined, undefined, 8);
  assert.deepEqual(selected.rows.map(r => r.site), ["Region 8"]);
  const metrics = { sun_hours: 3, earth_hours: 4, both_hours: 3, longest_both_h: 2 } as NonNullable<typeof terrain.sites[0]["metrics"]>;
  const complete = { ...terrain.sites[0], coverage_in_range: "complete" as const, metrics };
  assert.equal(workspaceGuideContext({ ...terrain, sites: [complete] }, null).rows[0].bothHours, 3);
  assert.equal(workspaceGuideContext({ ...terrain, sites: [{ ...complete, coverage_in_range: "partial" }] }, null).rows[0].bothHours, null);
});

test("responses accept only plain answers and known suggested actions", () => {
  assert.deepEqual(parseGuideReply({ answer: "  A  ", action: "saved" }), { answer: "A", action: "saved" });
  assert.equal(parseGuideReply({ answer: "A", action: "https://example.com" }).action, null);
  assert.throws(() => parseGuideReply({ answer: "<img src=x>", action: null }));
  assert.throws(() => parseGuideReply({ answer: "See https://example.org" }));
});

test("requests use same-origin POST and expose bounded service failures and cancellation", async t => {
  const input = { question: "Which site?", previousQuestion: "Both visible?", locale: "en" as const, context: savedGuideContext("im1_odysseus") };
  const send = t.mock.method(globalThis, "fetch", async (url: string, opts: RequestInit) => {
    assert.equal(url, "/guide/chat"); assert.equal(opts.method, "POST");
    assert.deepEqual(JSON.parse(String(opts.body)), input);
    return Response.json({ answer: "Result", action: null });
  });
  assert.equal((await askGuide(input, new AbortController().signal)).answer, "Result");
  send.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(askGuide(input, new AbortController().signal), (e: unknown) => e instanceof GuideRequestError && e.reason === "offline");
  send.mock.mockImplementation(async (_url: string, opts: RequestInit) => {
    opts.signal?.throwIfAborted();
    return Response.json({});
  });
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(askGuide(input, cancel.signal), { name: "AbortError" });
});
