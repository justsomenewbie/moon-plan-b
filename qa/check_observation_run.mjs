import assert from "node:assert/strict";

const origin = process.argv[2];
if (!origin) throw new Error("Pass a live frontend origin that can read the team API.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true,
  ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
const a2 = "A2_horizons_trek_raymarch_2026_2030_fix676af9d";
const ids = ["im1_odysseus", "im2_athena"];
const week = ["2026-11-14T00:00:00Z", "2026-11-21T00:00:00Z"];
const changed = ["2026-11-18T00:00:00Z", "2026-11-20T00:00:00Z"];
const dataset = url => url.pathname === "/api/v1/dataset" && url.origin === new URL(origin).origin;

async function capture(page, action) {
  const [response] = await Promise.all([
    page.waitForResponse(r => dataset(new URL(r.url())) && r.request().method() === "GET", { timeout: 60_000 }), action(),
  ]);
  return response;
}

async function checkResult(page, response, dates, expectedPin, submitted = false) {
  assert.equal(response.status(), 200, "Live dataset HTTP status");
  const query = new URL(response.url()).searchParams;
  const data = await response.json();
  const id = data.run.run_id;
  assert.equal(query.get("run_id"), expectedPin, "Run requested");
  if (expectedPin !== null) assert.equal(id, expectedPin, "Run returned");
  assert.ok(id, "Producer must identify the run");
  assert.deepEqual(query.get("site_ids")?.split(","), ids);
  assert.deepEqual([query.get("start"), query.get("end")], dates);
  assert.deepEqual([data.range.start, data.range.end], dates);
  assert.deepEqual(data.sites.map(s => s.id), ids);
  if (submitted) {
    await page.waitForURL(url => url.searchParams.get("run_id") === id &&
      url.searchParams.get("from") === dates[0] && url.searchParams.get("to") === dates[1]);
  }
  const run = page.locator("#sources dt").filter({ hasText: /^Run ID$/ });
  await run.waitFor();
  assert.equal(await run.locator("..").locator("dd code").textContent(), id);
  const share = page.getByRole("link", { name: "Open selected observation in a new tab", exact: true });
  const href = new URL(await share.getAttribute("href"), origin);
  assert.deepEqual(["run_id", "from", "to"].map(key => href.searchParams.get(key)), [id, ...dates]);
  for (const site of data.sites) {
    const card = page.locator("#workspace article").filter({ has: page.getByRole("heading", { name: site.name, exact: true }) });
    const total = card.locator("dt").filter({ hasText: "Total time with both visible" });
    assert.equal(await total.locator("..").locator("strong").textContent(), site.metrics.both_hours + " h");
  }
  console.log(id, dates.join(" to "), data.sites.map(s => s.id + "=" + s.metrics.both_hours + "h").join(", "));
  return id;
}

async function submit(page, dates, retainedDates) {
  const panel = page.locator("details.request-panel");
  if (!(await panel.evaluate(el => el.open))) await panel.locator("summary").click();
  if (retainedDates) {
    const restored = await Promise.all(["from", "to"].map(name => panel.locator('[name="' + name + '"]').inputValue()));
    assert.deepEqual(restored.map(value => Date.parse(value + "Z")), retainedDates.map(value => Date.parse(value)), "Failed request restored in form");
  } else {
    await panel.locator('[name="from"]').fill(dates[0].slice(0, -1));
  }
  await panel.locator('[name="to"]').fill(dates[1].slice(0, -1));
  return capture(page, () => panel.getByRole("button", { name: "Load windows", exact: true }).click());
}

try {
  for (const mode of ["explicit A2", "discover default", "A2 after first-load failure"]) {
    const page = await browser.newPage();
    try {
      const url = new URL("/compare", origin);
      const pinned = mode !== "discover default";
      const failedDates = mode === "A2 after first-load failure" ? [changed[0], week[1]] : undefined;
      const initialDates = failedDates ?? week;
      if (pinned) url.search = new URLSearchParams({ from: initialDates[0], to: initialDates[1], resolutionSeconds: "3600", run_id: a2 });
      if (mode === "A2 after first-load failure") {
        await page.route(dataset, route => route.fulfill({ status: 404, contentType: "application/problem+json",
          json: { type: "about:blank", title: "Run not found", detail: "Controlled initial lookup failure.", status: 404, code: "RUN_NOT_FOUND" } }), { times: 1 });
      }
      const first = await capture(page, () => page.goto(url.href, { waitUntil: "domcontentloaded" }));
      let id = a2;
      if (mode === "A2 after first-load failure") {
        assert.equal(first.status(), 404);
        assert.equal(new URL(first.url()).searchParams.get("run_id"), a2);
        await page.getByRole("button", { name: "Retry API request", exact: true }).waitFor();
      } else {
        id = await checkResult(page, first, week, pinned ? a2 : null);
        if (pinned) await checkResult(page, await submit(page, week), week, id, true);
      }
      await checkResult(page, await submit(page, changed, failedDates), changed, id, true);
      console.log("PASS", mode);
    } catch (error) {
      console.error("FAIL", mode, error.message);
      process.exitCode = 1;
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
