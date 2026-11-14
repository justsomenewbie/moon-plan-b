import assert from "node:assert/strict";

const origin = new URL(process.argv[2]).origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ serviceWorkers: "block", timezoneId: "Asia/Ho_Chi_Minh" });
  const run = "B_spice_pgda_bruteforce_2026_2030", ids = ["a3_haworth", "apollo11"];
  const from = "2026-11-14T00:00:00Z", hour = "2026-11-14T01:00:00Z", next = "2026-11-14T02:00:00Z";
  const end = "2026-11-14T01:00:00.000000001Z";
  const query = new URLSearchParams({ run_id: run, site_ids: ids.join(","), from, to: end, resolutionSeconds: "3600" });
  let rankings = 0;
  page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/v1/compare") rankings++; });
  const aggregate = () => page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/dataset");
  async function checkResponse(response, rawEnd, evaluatedEnd, samples) {
    assert.equal(response.status(), 200);
    const params = new URL(response.url()).searchParams;
    for (const [name, value] of Object.entries({ run_id: run, site_ids: ids.join(","), start: from, end: rawEnd }))
      assert.deepEqual(params.getAll(name), [value]);
    const data = await response.json();
    assert.equal(data.run.run_id, run);
    assert.deepEqual([data.range.start, data.range.end, data.range.n_samples], [from, evaluatedEnd, samples.length]);
    assert.deepEqual(data.sites.map(s => s.id), ids);
    for (const site of data.sites) assert.deepEqual(site.series.t, samples);
  }
  const [initial] = await Promise.all([aggregate(), page.goto(origin + "/compare?" + query + "#terrain-pair")]);
  await checkResponse(initial, end, next, [from, hour]);
  await page.getByRole("region", { name: "Pair comparison results" }).waitFor();
  assert.equal(rankings, 1);
  const workspace = page.locator("#workspace");
  await workspace.locator('time[datetime="' + end + '"]').first().waitFor({ state: "attached" });
  const editor = page.locator("details").filter({ has: page.locator('input[name="to"]') }).last();
  await editor.locator("summary").click();
  const input = editor.locator('[name="to"]');
  assert.equal(await input.inputValue(), end.slice(0, -1));
  const reload = editor.getByRole("button", { name: "Load windows" });
  const [same] = await Promise.all([aggregate(), reload.click()]);
  await checkResponse(same, end, next, [from, hour]);
  await workspace.locator('time[datetime="' + end + '"]').first().waitFor({ state: "attached" });
  const retained = new URL(page.url()).searchParams;
  for (const [k, v] of query) assert.equal(retained.get(k), v);
  assert.equal(await input.inputValue(), end.slice(0, -1));

  const dates = page.locator("#terrain-dates");
  await dates.locator("summary").first().click();
  await dates.getByText("The date comparison starts from the evaluated model window. The original request includes sub-millisecond precision.").waitFor();
  const dateValues = await dates.locator('input[name="firstStart"], input[name="firstEnd"]').evaluateAll(nodes => nodes.map(el => el.valueAsNumber));
  assert.deepEqual(dateValues, [Date.parse(from), Date.parse(next)]);
  assert.equal(rankings, 1);

  // Exactly on the hour, the second sample falls outside the half-open window.
  await input.fill(hour.slice(0, -1));
  const [exact] = await Promise.all([aggregate(), reload.click()]);
  await checkResponse(exact, hour, hour, [from]);
  assert.equal(rankings, 1);
  console.log("A one-nanosecond end retained both run-pinned sites and the final sample; the exact-hour control retained one sample.");
} finally { await browser.close(); }
