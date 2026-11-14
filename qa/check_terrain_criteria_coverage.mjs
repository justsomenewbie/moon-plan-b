import assert from "node:assert/strict";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running Moon Plan B frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const utc = hour => `2026-01-01T0${hour}:00:00Z`;
const thresholds = [1, 2, 8];

// Both synthetic sites share a clamped request. Only the second also has gaps inside the evaluated range.
function site(complete) {
  const hours = complete ? 4 : 2;
  const window = { start: utc(0), end: utc(hours), duration_h: hours, clipped_start: true, clipped_end: complete };
  const name = complete ? "Complete site" : "Partial site";
  return {
    id: complete ? "complete" : "partial", name, coverage: "partial", coverage_in_range: complete ? "complete" : "partial",
    windows: { sun: [window], earth: [window], both: [window] },
    metrics: complete ? { duration_h: 4, sun_hours: 4, earth_hours: 4, both_hours: 4, longest_sun_h: 4, longest_earth_h: 4,
      longest_both_h: 4, longest_dark_h: 0, longest_comms_gap_h: 0, pct_sun: 100, pct_earth: 100, pct_both: 100 } : null,
    criteria: thresholds.map(minimum_hours => ({ minimum_hours, metric: "longest_both_h", value_h: hours, value_clipped: true,
      result: minimum_hours > hours ? "below" : !complete && minimum_hours === 2 ? "borderline" : "meets",
      reason: `Original assessment for ${name} at ${minimum_hours} h.` })),
  };
}
const dataset = {
  schema_version: "lunarnav-dataset-1", evidence: "computed-ephemeris", dataset_id: "coverage-test", attribution: "Synthetic browser test",
  include: ["windows", "metrics", "criteria"], criteria_hours: thresholds, sources: [],
  range: { start: utc(0), end: utc(4), requested_start: utc(0), requested_end: utc(8), step_s: 3600, n_samples: 4 },
  run: { run_id: "test", label: "Test", provider: "test", dem: "test", horizon_method: "test", code_version: "test",
    run_timestamp_utc: utc(0), observer_height_m: 2, min_earth_clearance_deg: 0, git_commit: null,
    manifest_sha256: "a".repeat(64), manifest_url: "/api/v1/runs/test/files/manifest.json" },
  model: { id: "lunarnav-terrain-horizon-v1", label: "Fixture", definition: "Synthetic", limits: ["Test only"] },
  sites: [site(true), site(false)],
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();
  await page.getByLabel("Import JSON dataset").setInputFiles({
    name: "coverage.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(dataset)),
  });
  for (const entry of dataset.sites) {
    const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: entry.name, exact: true }) });
    const criteria = card.getByRole("region", { name: "Continuous Sun and Earth visibility requirements" });
    await criteria.waitFor();
    const complete = entry.coverage_in_range === "complete";
    const summary = complete ? "Longest overlap in the evaluated range: 4 h" : "Longest observed overlap: 2 h";
    assert.ok((await criteria.innerText()).includes(summary), entry.name + " should show " + summary);
    const headings = criteria.locator("summary");
    assert.equal(await headings.count(), entry.criteria.length);
    for (const [i, row] of entry.criteria.entries()) {
      const expected = row.result === "meets" ? "Meets the criterion" : complete ? "Below the criterion" : "Unknown across observation gaps";
      assert.equal((await headings.nth(i).innerText()).trim(), `At least ${row.minimum_hours} h · ${expected}`);
      await headings.nth(i).click();
      const disclosure = criteria.locator("details").nth(i);
      assert.ok((await disclosure.innerText()).includes(row.reason));
      if (!complete) assert.ok((await disclosure.innerText()).includes("Assessment of the observed intervals"));
    }
  }
  console.log("Complete and partial threshold labels, measured hours and original producer reasons passed.");
} finally { await browser.close(); }
