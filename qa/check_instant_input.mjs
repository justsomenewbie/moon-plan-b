import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const origin = new URL(process.argv[2]).origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ serviceWorkers: "block", timezoneId: "Asia/Ho_Chi_Minh" });
  const run = "instant-input", start = "2026-01-01T00:00:00Z", end = "2026-01-01T04:00:00Z";
  const sample = "2026-01-01T02:00:00Z", requested = "2026-01-01T02:30:00Z";
  const fixture = terrainFixture({ run, start, at: sample, end });
  const site = fixture.sites[0].id, calls = [];
  let sunlight = {};
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), "GET");
    if (url.pathname === "/api/v1/dataset") return route.fulfill({ json: fixture });
    assert.equal(url.pathname, "/api/v1/sites/" + site + "/instant");
    calls.push(Object.fromEntries(url.searchParams));
    const body = { az_deg: 0, el_deg: -1, horizon_el_deg: 0, clearance_deg: -1, visible: false };
    return route.fulfill({ json: { run_id: run, site_id: site, precision_h: 1, step_s: 3600, t: requested,
      sample_utc: sample, sun: { ...body, az_deg: 67.183128, ...sunlight }, earth: { ...body, az_deg: 348.75, el_deg: -0.030582, clearance_deg: -0.030582, fraction: 0.479104 }, both_visible: false } });
  });
  await page.goto(origin + "/compare?" + new URLSearchParams({ run_id: run, from: start, to: end, resolutionSeconds: "7200" }));
  const input = page.locator('#terrain-observations input[name="instantUtc"]');
  await input.waitFor({ state: "attached" });
  // Open and type in one turn so the native asynchronous toggle event always follows the edit.
  const retained = await input.evaluate(async (el, utc) => {
    const details = el.closest("details");
    const toggled = new Promise(resolve => details.addEventListener("toggle", resolve, { once: true }));
    details.querySelector("summary").click();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, utc);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await toggled;
    return el.value;
  }, requested.slice(0, 19));
  assert.equal(Date.parse(retained + "Z"), Date.parse(requested));
  const submit = page.getByRole("button", { name: "Look up observation", exact: true });
  await input.fill(end.slice(0, 19));
  await submit.click();
  assert(await input.evaluate(el => el.validity.rangeOverflow));
  assert.deepEqual(calls, []);
  await input.fill(requested.slice(0, 19));
  await submit.click();
  const result = page.getByRole("region", { name: "Observation at the requested time" });
  await result.waitFor();
  assert.deepEqual(calls, [{ run_id: run, t: requested }]);
  assert.deepEqual(await result.locator("time").evaluateAll(nodes => nodes.map(el => el.dateTime)), [requested, sample]);
  assert.deepEqual(await result.locator(".instant-bearing strong").allTextContents(), ["east-northeast", "north"]);
  assert.deepEqual(await result.locator(".instant-bearing path[transform]").evaluateAll(paths => paths.map(p => p.getAttribute("transform"))),
    ["rotate(67.183128 18 18)", "rotate(348.75 18 18)"]);
  assert.equal(await result.getByRole("meter").count(), 0);
  assert.equal(await result.locator(".panel-missing").count(), 2);
  sunlight = { power_horizontal: 0 };
  await submit.click();
  await result.getByRole("meter", { name: "Horizontal panel" }).waitFor();
  assert.equal(await result.getByRole("meter").getAttribute("aria-valuetext"), "0%");
  assert.deepEqual(await result.locator(".panel-missing").allTextContents(), ["Sun-facing panel · No data for this sample"]);
  const earthGroup = result.locator(".week-sites > div").filter({has: page.getByRole("heading", {name:"Earth", exact:true})});
  const field = (section, title) => section.getByText(title, { exact: true }).locator("..").locator("dd");
  assert.equal(await field(earthGroup, "Earth’s centre exceeds the run’s clearance threshold").innerText(), "No");
  assert.equal(await field(earthGroup, "Share of Earth’s disc above the local horizon").innerText(), "47.9104%");
  await page.locator(".language-switch select").first().selectOption("vi");
  const viEarth = page.locator("#instant-heading").locator("..").locator(".week-sites > div").filter({has: page.getByRole("heading", {name:"Trái Đất", exact:true})});
  assert.equal(await field(viEarth, "Tâm Trái Đất vượt ngưỡng góc cao so với đường chân trời của lần chạy").innerText(), "Không");
  assert.equal(await field(viEarth, "Tỷ lệ diện tích đĩa Trái Đất nằm trên đường chân trời địa phương").innerText(), "47,9104%");
  const viResult = viEarth.locator("..");
  assert.deepEqual(await viResult.locator(".instant-bearing strong").allTextContents(), ["đông đông bắc", "bắc"]);
  assert.match(await viResult.locator(".instant-bearing").first().innerText(), /67,18°/);
  assert.equal(await field(viEarth, "Góc phương vị").innerText(), "348,75°");
  console.log("UTC input, native sample, localized Sun and Earth bearings, zero and absent sunlight values passed.");
} finally { await browser.close(); }
