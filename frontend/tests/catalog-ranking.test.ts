import test from "node:test";
import assert from "node:assert/strict";
import { getCatalogRanking, type CatalogRanking } from "../lib/api/catalog-ranking.ts";
import type { SiteComparison } from "../lib/api/compare-sites.ts";
import { ApiError } from "../lib/api/client.ts";

const weights = { pct_sun: 0.4, pct_earth: 0.3, pct_both: 0.3 };
const range = { start: "2026-11-14T00:00:00Z", end: "2026-11-15T00:00:00Z", step_s: 3600, n_samples: 24 };
function row(site_id: string, rank: number, sun: number, earth: number) {
  const both = Math.min(sun, earth);
  return { site_id, rank, name: site_id, group: "unit", score: 0.4 * sun + 0.3 * earth + 0.3 * both,
    pct_sun: sun, pct_earth: earth, pct_both: both, pct_sun_no_earth: sun - both, mean_power_tracking: 0,
    longest_dark_h: sun ? 0 : 24, longest_comms_gap_h: earth ? 0 : 24,
    longest_dark_truncated: true, longest_comms_gap_truncated: true, reasons: ["Synthetic fixture."] };
}
// The catalog includes multiple other sites and a real tie in this invented 24-sample window.
function example(): { catalog: CatalogRanking; pair: SiteComparison } {
  const ranking = [row("bright", 1, 100, 100), row("a-east", 2, 0, 100), row("b-east", 3, 0, 100), row("dark", 4, 0, 0)];
  const catalog: CatalogRanking = { run_id: "unit", step_s: 3600, precision_h: 1, weights, range, source: "computed", ranking };
  const pair: SiteComparison = { ...catalog, sites: {}, ranking: [{ ...ranking[2], rank: 1 }, { ...ranking[3], rank: 2 }],
    coverageBySite: { "b-east": "complete", dark: "complete" } };
  return structuredClone({ catalog, pair });
}

test("gets the whole catalog once with pinned dates and matching explicit weights; catalog positions differ from pair positions", async t => {
  const { catalog, pair } = example();
  const sites = catalog.ranking.map(row => ({ id: row.site_id }));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    calls++;
    const url = new URL(req.url);
    assert.equal(req.method, "GET"); assert.equal(url.pathname, "/api/v1/ranking");
    assert.deepEqual(Object.fromEntries(url.searchParams), { run_id: "unit", start: range.start, end: range.end,
      weights: "pct_sun:0.4,pct_earth:0.3,pct_both:0.3,pct_sun_no_earth:0" });
    return Response.json(catalog);
  });
  const response = await getCatalogRanking(pair, undefined, sites);
  assert.equal(calls, 1);
  assert.equal(response.ranking.length, 4);
  assert.equal(response.ranking.find(r => r.site_id === "b-east")?.rank, 3);
  assert.equal(pair.ranking[0].rank, 1);
  assert.equal(response.source, "computed");
  catalog.source = "summary";
  assert.equal((await getCatalogRanking(pair, undefined, sites)).source, "summary");
});

test("rejects incompatible identity, range, weight, order, counts or selected row evidence", async t => {
  const { pair, catalog } = example();
  let reply = structuredClone(catalog);
  t.mock.method(globalThis, "fetch", async () => Response.json(reply));
  const changes = [
    () => { reply.run_id = "other"; }, () => { reply.range.end = range.start; }, () => { reply.precision_h = 0; },
    () => { reply.range.n_samples--; }, () => { reply.step_s++; }, () => { reply.weights.pct_both = 0; },
    () => { Object.assign(reply, { source: "catalog" }); }, () => { reply.ranking.pop(); },
    () => { reply.ranking[0].site_id = "a-east"; }, () => { reply.ranking[2].rank = 1; },
    () => { reply.ranking[2].name = "Different"; }, () => { reply.ranking[2].longest_comms_gap_truncated = false; },
    () => { reply.ranking[0].mean_power_tracking = 2; }, () => { reply.ranking[0].pct_both = 20; },
    () => { reply.ranking[0].score = 104; }, () => { reply.ranking[2].mean_power_tracking = 0.2; },
    () => { [reply.ranking[1], reply.ranking[2]] = [reply.ranking[2], reply.ranking[1]]; reply.ranking.forEach((r, i) => { r.rank = i + 1; }); },
    () => { reply.ranking[1].longest_dark_h = 24; reply.ranking[2].longest_dark_h = 20; },
  ];
  for (const change of changes) {
    reply = structuredClone(catalog); change();
    await assert.rejects(getCatalogRanking(pair), (e: unknown) => e instanceof ApiError && e.status === 502);
  }
});

test("withholds requests when coverage is incomplete or a request has been cancelled, and preserves producer errors", async t => {
  const { pair } = example();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ detail: "No run" }, { status: 404 }); });
  await assert.rejects(getCatalogRanking(pair, AbortSignal.abort()), { name: "AbortError" });
  pair.coverageBySite.dark = "partial";
  await assert.rejects(getCatalogRanking(pair), (e: unknown) => e instanceof ApiError && e.status === 422);
  assert.equal(calls, 0);
  pair.coverageBySite.dark = "complete";
  await assert.rejects(getCatalogRanking(pair), (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === "No run");
  assert.equal(calls, 1);
});

test("ties the ranking denominator and membership to the pinned run's site list", async t => {
  const { pair, catalog } = example();
  const sites = catalog.ranking.map(row => ({ id: row.site_id }));
  let reply = structuredClone(catalog);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(reply); });
  assert.equal((await getCatalogRanking(pair, undefined, sites)).ranking.length, sites.length);
  reply.ranking = structuredClone(catalog.ranking.slice(1)).map((row, i) => ({ ...row, rank: i + 1 }));
  await assert.rejects(getCatalogRanking(pair, undefined, sites), (e: unknown) => e instanceof ApiError && e.status === 502);
  reply = structuredClone(catalog);
  reply.ranking[0].site_id = "unknown";
  await assert.rejects(getCatalogRanking(pair, undefined, sites), (e: unknown) => e instanceof ApiError && e.status === 502);
  assert.equal(calls, 3);
});

test("recovers the full run catalog on demand when it was unavailable in the pair selector", async t => {
  const { pair, catalog } = example();
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (req: Request) => {
    const url = new URL(req.url);
    paths.push(url.pathname);
    assert.equal(url.searchParams.get("run_id"), pair.run_id);
    if (url.pathname === "/api/v1/ranking") return Response.json(catalog);
    assert.equal(url.searchParams.has("group"), false);
    return Response.json({ run_id: pair.run_id, sites: catalog.ranking.map(row => ({
      id: row.site_id, name: row.name, dem_source: "test", horizon_method: "test",
    })) });
  });
  assert.equal((await getCatalogRanking(pair)).ranking.length, 4);
  assert.deepEqual(paths, ["/api/v1/ranking", "/api/v1/sites"]);
});
