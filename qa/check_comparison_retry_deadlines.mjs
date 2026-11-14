import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

// All service responses are controlled locally. The timing test exercises actual visible controls.
const origin = new URL(process.argv[2]).origin;
const run = "comparison-retry", start = "2026-01-01T00:00:00Z", end = "2026-01-01T04:00:00Z", sample = "2026-01-01T02:00:00Z";
const fixture = terrainFixture({ run, start, at: sample, end });
const ids = fixture.sites.map(site => site.id);
const sites = fixture.sites.map(site => ({ id: site.id, name: site.name, horizon_method: "test", dem_source: "test" }));
const dark = { start, end, state: false, duration_h: 4, clipped_start: true, clipped_end: true, truncated_start: false, truncated_end: false };
const metrics = { duration_h: 4, pct_sun: 0, pct_earth: 0, pct_both: 0, pct_sun_no_earth: 0, longest_dark_h: 4, longest_dark_truncated: true,
  longest_comms_gap_h: 4, longest_comms_gap_truncated: true, longest_sun_h: 0, longest_sun_truncated: false, longest_earth_h: 0,
  longest_earth_truncated: false, n_sun_windows: 0, n_dark_windows: 1, n_earth_windows: 0, n_comms_gaps: 1,
  mean_sun_el_lit_deg: null, mean_power_horizontal: 0, mean_power_tracking: 0 };
const ranking = ids.map((id, i) => ({ ...metrics, site_id: id, name: id, group: "fixture", rank: i + 1, score: 0, reasons: [] }));
const compare = { run_id: run, step_s: 3600, precision_h: 1, range: { start, end, step_s: 3600, n_samples: 4 },
  weights: { pct_sun: .4, pct_earth: .3, pct_both: .3 }, ranking,
  sites: Object.fromEntries(ids.map(id => [id, { metrics, windows: { sun: [dark], earth: [dark], both: [dark] }, warnings: [] }])) };
const body = { az_deg: 0, el_deg: -1, horizon_el_deg: 0, clearance_deg: -1, visible: false };
const browserApi = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await browserApi.chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ serviceWorkers: "block", timezoneId: "Asia/Ho_Chi_Minh" });
const calls = { catalog: [], ranking: [], instant: [], files: [] };
const unexpected = [];
async function reply(route, key, json, status = 429) {
  const url = new URL(route.request().url());
  calls[key].push(Object.fromEntries(url.searchParams));
  if (calls[key].length === 1) return route.fulfill({ status, headers: { "Retry-After": "60" },
    json: { title: "Test wait", detail: "Please retry manually.", status, type: "about:blank", code: status === 429 ? "RATE_LIMITED" : "TEST_BUSY" } });
  return route.fulfill({ json });
}
await page.route("**/api/**", route => {
  const url = new URL(route.request().url());
  if (route.request().method() === "POST" && url.pathname === "/api/v1/compare") return route.fulfill({ json: compare });
  if (route.request().method() === "GET") {
    if (url.pathname === "/api/v1/dataset") return route.fulfill({ json: fixture });
    if (url.pathname === "/api/v1/sites") return reply(route, "catalog", { run_id: run, sites });
    if (url.pathname === "/api/v1/ranking") return reply(route, "ranking", { ...compare, source: "computed" });
    if (url.pathname === "/api/v1/runs/" + run) return reply(route, "files", { run_id: run, status: "ready",
      run_timestamp_utc: start, code_version: fixture.run.code_version, manifest: { files: [{ path: "manifest.json", sha256: "a".repeat(64) }] } }, 503);
    if (url.pathname === "/api/v1/sites/" + ids[0] + "/instant") return reply(route, "instant", { run_id: run, site_id: ids[0],
      t: url.searchParams.get("t"), sample_utc: sample, step_s: 3600, precision_h: 1, both_visible: false, sun: body, earth: body });
  }
  unexpected.push(url.pathname);
  return route.abort();
});
const panel = summary => page.getByText(summary, { exact: true }).locator("..");
const summary = details => details.locator(":scope > summary");
const button = details => details.getByRole("button", { name: /Try again in \d+ s/ });
async function waiting(details) {
  await button(details).waitFor();
  assert(await button(details).isDisabled());
}
try {
  await page.goto(origin + "/compare?" + new URLSearchParams({ run_id: run, from: start, to: end, resolutionSeconds: "7200" }));
  const pair = page.locator("#terrain-pair"), dates = page.locator("#terrain-dates > details");
  const instant = page.locator("details:has(> form input[name=instantUtc])"), files = panel("Original files from this run");
  await page.locator("#terrain-sample-utc").waitFor();
  await page.clock.install();
  await summary(pair).click();
  await waiting(pair);
  await summary(pair).click();
  await summary(dates).click();
  await waiting(dates);
  await summary(pair).click();
  await waiting(pair);
  assert.equal(calls.catalog.length, 1, "pair and date panels share the site list's wait");
  assert(await pair.getByRole("button", { name: "Compare this pair", exact: true }).isEnabled());
  assert(await dates.getByRole("button", { name: "Compare these dates", exact: true }).isEnabled());

  await summary(files).click();
  await waiting(files);
  await summary(files).click();
  await summary(files).click();
  await waiting(files);
  assert.equal(calls.files.length, 1);

  await summary(instant).click();
  const clock = instant.locator("input[name=instantUtc]");
  await clock.fill("2026-01-01T02:12");
  await instant.getByRole("button", { name: "Look up observation" }).click();
  await waiting(instant);
  await clock.fill("2026-01-01T02:30");
  await summary(instant).click();
  await summary(instant).click();
  await waiting(instant);
  assert.equal(await clock.inputValue(), "2026-01-01T02:30");
  await page.locator(".language-switch select").first().selectOption("vi");
  assert(await instant.getByRole("button", { name: /Thử lại sau \d+ giây/ }).isDisabled());
  await page.locator(".language-switch select").first().selectOption("en");
  await page.clock.fastForward(61_000);
  const ready = pair.getByRole("button", { name: "Retry site list", exact: true });
  await ready.waitFor();
  assert.deepEqual([calls.catalog.length, calls.files.length, calls.instant.length], [1, 1, 1], "expiry alone never retries");
  await ready.click();
  await pair.getByText("The full site list is unavailable.", { exact: false }).waitFor({ state: "detached" });
  assert.equal(calls.catalog.length, 2);
  assert.equal(await dates.getByRole("button", { name: "Retry site list" }).count(), 0);
  await files.getByRole("button", { name: "Retry", exact: true }).click();
  await files.getByRole("link", { name: "Download selected source file" }).waitFor();
  await instant.getByRole("button", { name: "Retry observation lookup" }).click();
  await instant.getByRole("region", { name: "Observation at the requested time" }).waitFor();
  assert.deepEqual(calls.instant, [{ run_id: run, t: "2026-01-01T02:12:00Z" }, { run_id: run, t: "2026-01-01T02:30:00Z" }]);

  await pair.getByRole("button", { name: "Compare this pair" }).click();
  const ranks = pair.locator("#catalog-ranking");
  await ranks.getByRole("button", { name: "Show catalog ranks" }).click();
  await waiting(ranks);
  await summary(pair).click();
  await summary(pair).click();
  await waiting(ranks);
  await page.clock.fastForward(61_000);
  const rankRetry = ranks.getByRole("button", { name: "Retry catalog ranking" });
  await rankRetry.waitFor();
  assert.equal(calls.ranking.length, 1);
  await rankRetry.click();
  await ranks.getByRole("heading", { name: "Catalog ranking for the selected sites" }).waitFor();
  assert.deepEqual(calls.ranking[0], calls.ranking[1]);
  assert.deepEqual(calls.catalog[0], calls.catalog[1]);
  assert.equal(calls.ranking[1].run_id, run);
  assert.deepEqual([calls.ranking[1].start, calls.ranking[1].end], [start, end]);
  assert.deepEqual([calls.catalog.length, calls.files.length, calls.ranking.length, calls.instant.length], [2, 2, 2, 2]);
  assert.deepEqual(unexpected, []);
  console.log("Comparison catalog, ranking, instant and run files honored 429/503 waits, preserved UTC and recovered only on manual retry.");
} finally { await browser.close(); }
