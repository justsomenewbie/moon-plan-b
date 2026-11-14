import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const origin = process.argv[2];
if (!origin) throw Error("Pass a frontend URL configured for the team API.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const run = "imported-alternate-run";
const utc = h => new Date(Date.UTC(2026, 0, 1, h)).toISOString().replace(".000Z", "Z");
const dataset = terrainFixture({ run, start: utc(0), at: utc(12), end: utc(24) });
// This synthetic imported release gives Athena eight joint hours starting at 04:00 and Odysseus three starting at 15:00.
dataset.include = ["windows", "metrics"];
dataset.range.n_samples = 24;
delete dataset.criteria_hours;
dataset.sites = dataset.sites.map(site => {
  const athena = site.id === "im2_athena";
  const hours = athena ? 8 : 3, start = athena ? 4 : 15;
  const window = { start: utc(start), end: utc(start + hours), duration_h: hours, clipped_start: false, clipped_end: false };
  const gap = Math.max(start, 24 - start - hours), pct = 100 * hours / 24;
  return { id: site.id, name: athena ? "IM-2 Athena" : "IM-1 Odysseus", coverage: "complete", coverage_in_range: "complete",
    windows: { sun: [window], earth: [window], both: [window] }, metrics: { duration_h: 24, sun_hours: hours, earth_hours: hours,
      both_hours: hours, longest_sun_h: hours, longest_earth_h: hours, longest_both_h: hours, longest_dark_h: gap,
      longest_comms_gap_h: gap, pct_sun: pct, pct_earth: pct, pct_both: pct } };
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });
try {
  for (const locale of ["en", "vi"]) {
    const en = locale === "en", page = await browser.newPage({ serviceWorkers: "block", reducedMotion: "reduce" });
    const api = [], llm = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(l => localStorage.setItem("moon-plan-b-language", l), locale);
    await page.route("**/api/**", route => {
      api.push(route.request().url());
      return route.fulfill({ status: 503, json: { title: "Fixture outage", detail: "Fixture outage" } });
    });
    await page.route("**/guide/chat", route => { llm.push(route.request().url()); return route.abort(); });
    const url = new URL("/compare", origin);
    url.search = new URLSearchParams({ run_id: "different-live-run", site_id: "im1_odysseus", from: utc(0), to: utc(24), resolutionSeconds: "3600" });
    await page.goto(url.href);
    await page.locator("#data-error").getByText("Fixture outage", { exact: true }).waitFor();
    assert.ok(api.some(call => new URL(call).searchParams.get("run_id") === "different-live-run"));
    await page.getByRole("button", { name: en ? "Import data" : "Nhập dữ liệu", exact: true }).click();
    await page.locator("#import-dialog input[type=file]").setInputFiles({
      name: "alternate-release.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(dataset)),
    });
    await page.locator("#workspace.terrain-result").waitFor();
    assert.equal(new URL(page.url()).searchParams.has("run_id"), false);
    const before = api.length;
    await page.getByRole("button", { name: en ? "Astronaut guide" : "Hướng dẫn của phi hành gia", exact: true }).click();
    const chat = page.getByRole("region", { name: en ? "Ask the astronaut" : "Hỏi phi hành gia" });
    await chat.locator("select").selectOption("workspace");
    async function ask(question, expected) {
      const turns = chat.locator("[role=log] > div");
      const index = await turns.count();
      await chat.locator("textarea").fill(question);
      await chat.locator("button[type=submit]").click();
      const answer = turns.nth(index).locator("p").nth(1);
      await answer.waitFor();
      const text = await answer.innerText();
      for (const value of [run, ...expected]) assert.ok(text.includes(value), "Missing " + value + " in " + text);
      assert.doesNotMatch(text, /B2_spice|different-live-run/);
      assert.equal(api.length, before, "A workspace question made a producer request.");
      assert.deepEqual(llm, []);
    }
    await ask(en ? "Which site is best for a 6-hour mission from 2026-01-01 to 2026-01-02?"
      : "Tôi muốn đi 6 giờ từ 2026-01-01 đến 2026-01-02, địa điểm nào tốt nhất?",
      ["IM-2 Athena", "2/2", "6 / 6 / 6 h", utc(4), utc(10), "3/19"]);
    await ask(en ? "When should I land at Athena or Odysseus for 2 hours from 2026-01-01 to 2026-01-02?"
      : "Khi nào nên đi Athena hoặc Odysseus 2 giờ từ 2026-01-01 đến 2026-01-02?",
      [en ? "Which of these retained sites" : "Bạn muốn sử dụng địa điểm nào", "IM-1 Odysseus", "IM-2 Athena"]);
    await ask("Odysseus", ["IM-1 Odysseus", "2 / 2 / 2 h", utc(15), utc(17), "2/23"]);
    await ask(en ? "Which site is best from 2026-01-02 to 2026-01-03?"
      : "Từ 2026-01-02 đến 2026-01-03, địa điểm nào tốt nhất?",
      [en ? "outside this workspace" : "nằm ngoài dữ liệu", utc(0), utc(24)]);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("Imported workspace planning passed in EN and VI for date-first, site-first and out-of-range questions; no planner or model calls.");
} finally { await browser.close(); }
