import assert from "node:assert/strict";

const origin = new URL(process.argv[2]).origin;
const run = "B2_spice_pgda_bruteforce_2026_2030_fix676af9d";
const dates = { from: "2026-11-28", to: "2026-12-12" };
const url = (source, extras = {}) => origin + "/plan?" + new URLSearchParams({
  ...dates, mode: "sites", priority: "joint", order: "longest", run_id: run, ...(source ? { source } : {}), ...extras,
});
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, chromiumSandbox: true });
const page = await browser.newPage({ serviceWorkers: "block" });
const rows = page.locator(".plan-results tbody tr");
const form = page.locator("form:has(select[name=priority])");
const ranking = form.locator("select[name=priority]");
const map = page.locator(".plan-map-inspector");
try {
  await page.goto(url("saved-b2"));
  const malapert = rows.filter({ hasText: "Malapert Massif" });
  assert.match(await rows.first().innerText(), /Odysseus/);
  assert.equal(await rows.count(), 23);
  assert.equal(await malapert.locator("td").first().innerText(), "76");
  assert.equal(await malapert.locator("td").last().innerText(), "114");
  assert.equal(await ranking.inputValue(), "longest");
  assert.match(await map.innerText(), /Longest joint window · 92 h/);
  await map.locator("select").selectOption("a3_malapert_massif");
  assert.match(await map.innerText(), /Longest joint window · 76 h/);
  await map.getByRole("link", { name: "Site details" }).click();
  assert.equal(new URL(page.url()).searchParams.get("order"), "longest");
  const field = page.locator("dl div:has(dt)").filter({ hasText: "Longest joint window" });
  assert.match(await field.innerText(), /76 h/);
  const back = page.getByRole("link", { name: "Back to these site results" });
  const query = new URL(await back.getAttribute("href"), origin).searchParams;
  for (const [key, value] of Object.entries({ ...dates, order: "longest", priority: "joint", run_id: run, site: "a3_malapert_massif" })) assert.equal(query.get(key), value);
  await back.click();
  await page.waitForFunction(() => document.activeElement.id === "site-results");
  assert.ok(await page.locator("#site-results").evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  }));
  assert.match(await rows.first().innerText(), /Odysseus/);
  assert.equal(await map.locator("select").inputValue(), "a3_malapert_massif");

  await ranking.selectOption("joint");
  await form.getByRole("button", { name: "Find sites" }).click();
  assert.match(await rows.first().innerText(), /Malapert/);
  const liveLink = page.getByRole("link", { name: "Return to the linked live run" });
  assert.equal(new URL(await liveLink.getAttribute("href"), origin).searchParams.has("order"), false);
  await ranking.selectOption("longest");
  assert.equal(new URL(await liveLink.getAttribute("href"), origin).searchParams.get("order"), "longest");
  await form.locator("[name=missionHours]").fill("24");
  assert(await form.getByRole("button", { name: "Find sites" }).isDisabled());
  await page.getByText(/Clear the mission duration/).waitFor();
  assert.equal(await rows.count(), 0);
  await ranking.selectOption("joint");
  await form.getByRole("button", { name: "Find sites" }).click();
  assert.equal(await rows.count(), 23);

  await page.goto(url("saved", { from: "2026-11-14", to: "2026-11-21" }));
  assert.equal(await ranking.inputValue(), "longest");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  assert.match(await rows.first().innerText(), /Athena/);
  await page.getByText("Saved observations: Odysseus and Athena only.").waitFor();
  await page.goto(url("saved"));
  await page.getByText(/Run B retains continuous windows only for/).waitFor();
  assert.equal(await rows.count(), 0);
  await page.locator(".language-switch select").first().selectOption("vi");
  await page.getByText(/Bản lưu B chỉ có các khoảng liên tục/).waitFor();

  await page.setViewportSize({ width: 320, height: 568 });
  for (const [priority, label, expected] of [
    ["sun", "Thấy Mặt Trời", 370], ["earth", "Thấy Trái Đất", 573],
    ["joint", "Đồng thời nhìn thấy", 357], ["longest", "Khoảng đồng thời dài nhất", 324],
  ]) {
    const query = new URLSearchParams({ mode: "sites", source: "saved-b2", from: "2026-12-29", to: "2027-01-28",
      priority: priority === "longest" ? "joint" : priority });
    if (priority === "longest") query.set("order", "longest");
    await page.goto(origin + "/plan?" + query);
    const header = page.locator(".plan-results thead th").nth(1);
    assert.equal(await header.innerText(), label + " (h)");
    assert.equal(await rows.filter({ hasText: "Athena" }).locator("td").first().innerText(), String(expected));
    assert.ok(await header.evaluate(el => el.getBoundingClientRect().right <= el.closest(".table-scroll").getBoundingClientRect().right + 1));
  }

  // Optional: exercise the same frontend build with genuine, bounded producer GETs.
  // A second argument supplies an anonymous public relay if the local server has no configured key.
  if (process.argv[3]) {
    const relay = new URL(process.argv[3]).origin;
    const calls = [];
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      assert.equal(route.request().method(), "GET");
      calls.push(url.pathname);
      const response = await page.request.get(relay + url.pathname + url.search);
      await route.fulfill({ response });
    });
    await page.goto(url(null));
    await ranking.waitFor();
    await page.locator(".language-switch select").first().selectOption("en");
    await form.getByRole("button", { name: "Find sites" }).click();
    assert.match(await rows.first().innerText({ timeout: 65000 }), /Odysseus/);
    assert.equal(await rows.count(), 23);
    assert.match(await map.innerText(), /Longest joint window · 92 h/);
    assert.deepEqual([...new Set(calls)].sort(), ["/api/v1/dataset", "/api/v1/ranking", "/api/v1/runs/" + run, "/api/v1/sites"].sort());
  }
  console.log("Longest joint ranking, total-hours control, legacy scope, map readout, saved detail and return links passed.");
} finally { await browser.close(); }
