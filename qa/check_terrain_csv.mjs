import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

// Pass a live-mode frontend origin and, optionally, a mock-mode frontend origin.
// All producer operations are intercepted. Downloads are real browser downloads of invented CSV fixtures.
const [liveOrigin, mockOrigin] = process.argv.slice(2);
if (!liveOrigin) throw new Error("Pass the live-mode frontend origin and optionally the mock-mode origin.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

const run = "csv-test-run", custom = "custom:-89.4500:222.6900";
const ids = ["im1_odysseus", "im2_athena"];
const utc = (day, hour) => `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;
const whole = { from: "2025-12-31T23:30:00Z", to: "2026-01-01T03:30:00Z" };
const dates = [1, 2].map(day => ({ from: utc(day, 0).replace(":00:00Z", ":20:00Z"), to: utc(day, 3).replace(":00:00Z", ":20:00Z") }));
const bounds = day => ({ start: utc(day, 0), at: utc(day, 2), end: utc(day, 4) });
const selector = 'a[href*="/export/"][href*=".csv"]';
const links = page => page.locator(selector);
const href = (origin, path, query) => new URL(path + "?" + new URLSearchParams(query), origin).href;

function dataset(day, siteIds, clamped = false) {
  const value = terrainFixture({ run, ...bounds(day) });
  if (clamped) value.range.requested_start = "2025-12-31T23:00:00Z";
  value.sites = siteIds.map((id, i) => ({ ...value.sites[i], id, name: id }));
  return value;
}

const rows = [];
const csvBody = (kind, range) => kind === "series"
  ? `time_utc,sun_visible,earth_visible,both_visible\n${range.start},0,0,0\n`
  : `kind,start,end,duration_h,state\nboth,${range.start},${range.end},4,0\n`;

async function attachLiveFixtures(page) {
  await page.context().route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), q = url.searchParams;
    assert.equal(req.method(), "GET");
    assert.equal(q.get("run_id"), run);
    if (url.pathname === "/api/v1/sites") {
      return route.fulfill({ json: { run_id: run, sites: [...ids, custom].map(id => ({
        id, name: id, dem_source: "test", horizon_method: "test",
      })) } });
    }
    if (url.pathname === "/api/v1/dataset") {
      const pair = q.get("site_ids") === ids.join(",");
      const expected = pair ? whole : dates.find(range => range.from === q.get("start"));
      assert.ok(expected && (pair || q.get("site_ids") === custom));
      assert.equal(q.get("start"), expected.from);
      assert.equal(q.get("end"), expected.to);
      return route.fulfill({ json: dataset(expected === dates[1] ? 2 : 1, pair ? ids : [custom], pair) });
    }
    const match = /^\/api\/v1\/sites\/([^/]+)\/export\/(series|windows)\.csv$/.exec(url.pathname);
    assert.ok(match, "Unexpected producer route " + url.pathname);
    const kind = match[2], range = { start: q.get("start"), end: q.get("end") };
    rows.push(url.href);
    return route.fulfill({ headers: {
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="test-${kind}.csv"`,
    }, body: csvBody(kind, range) });
  });
}

async function checkCard(page, card, site, day) {
  const range = bounds(day);
  assert.equal(await links(card).count(), 2);
  const record = card.getByRole("link", { name: "Open site record (full run, JSON)" });
  assert.equal(await record.getAttribute("href"), "/api/v1/sites/" + encodeURIComponent(site) + "?" + new URLSearchParams({ run_id: run }));
  for (const kind of ["series", "windows"]) {
    const anchor = card.locator(`a[href*="/export/${kind}.csv"]`);
    const url = new URL(await anchor.getAttribute("href"), page.url());
    assert.equal(url.origin, new URL(page.url()).origin);
    assert.equal(url.pathname, `/api/v1/sites/${encodeURIComponent(site)}/export/${kind}.csv`);
    for (const [key, expected] of Object.entries({ run_id: run, start: range.start, end: range.end }))
      assert.deepEqual(url.searchParams.getAll(key), [expected]);
    if (kind === "series") assert.deepEqual(url.searchParams.get("fields")?.split(","),
      ["sun_az_deg", "sun_el_deg", "sun_visible", "earth_az_deg", "earth_el_deg", "earth_visible", "both_visible"]);
    else assert.deepEqual(url.searchParams.get("kinds")?.split(","), ["sun", "earth", "both"]);
    const clicks = rows.length;
    const [download] = await Promise.all([page.waitForEvent("download"), anchor.click()]);
    assert.equal(download.url(), url.href);
    assert.equal(download.suggestedFilename(), "test-" + kind + ".csv");
    const body = [];
    for await (const chunk of await download.createReadStream()) body.push(chunk);
    assert.equal(Buffer.concat(body).toString(), csvBody(kind, range));
    assert.equal(await download.failure(), null);
    assert.deepEqual(rows.slice(clicks), [url.href]);
  }
}

async function checkLive() {
  const page = await browser.newPage({ serviceWorkers: "block", acceptDownloads: true });
  page.setDefaultTimeout(12000);
  await attachLiveFixtures(page);
  await page.goto(href(liveOrigin, "/compare", { ...whole, run_id: run, resolutionSeconds: "3600" }));
  const cards = page.locator("#workspace.terrain-result .week-sites").first().locator("article");
  await cards.first().waitFor();
  const runPath = "/api/v1/runs/" + run;
  const runLinks = (scope, path) => scope.locator('a[href="' + path + '"]');
  const manifestPath = runPath + "/files/manifest.json";
  assert.equal(await runLinks(page, runPath).count(), 1);
  assert.equal(await runLinks(page, manifestPath).count(), 1);
  assert.equal(await links(page).count(), 4);
  assert.equal(rows.length, 0);
  for (const [i, id] of ids.entries()) await checkCard(page, cards.nth(i), id, 1);
  assert.equal(rows.length, 4);

  // An ordinary local import is not a live query, even if its document names a valid run.
  const imported = dataset(3, ids);
  await page.locator("#import-dialog input[type=file]").setInputFiles({
    name: "local.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(imported)),
  });
  await page.waitForFunction(expected => document.querySelector("#terrain-sample-utc")?.dateTime === expected, bounds(3).start);
  assert.equal(await links(page).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Open site record (full run, JSON)" }).count(), 0);
  assert.equal(await runLinks(page, runPath).count(), 0);
  assert.equal(await runLinks(page, manifestPath).count(), 0);
  assert.ok(await page.locator("#sources").getByText(manifestPath, { exact: true }).isVisible());
  assert.equal(rows.length, 4);

  await page.goto(href(liveOrigin, "/compare-dates", {
    run_id: run, site_id: custom, from: dates[0].from, to: dates[0].to, from2: dates[1].from, to2: dates[1].to,
  }));
  const dateCards = page.locator("#terrain-dates .week-sites article");
  await dateCards.first().waitFor();
  assert.equal(await runLinks(page, runPath).count(), 1);
  assert.equal(await runLinks(page, manifestPath).count(), 1);
  assert.equal(await links(page).count(), 4);
  assert.equal(rows.length, 4);
  for (const day of [1, 2]) await checkCard(page, dateCards.nth(day - 1), custom, day);
  assert.equal(rows.length, 8);
  await page.close();
}

try {
  await checkLive();
  if (mockOrigin) {
    const mock = await browser.newPage();
    mock.setDefaultTimeout(12000);
    const mockExports = [];
    mock.on("request", req => { if (new URL(req.url()).pathname.includes("/export/")) mockExports.push(req.url()); });
    await mock.goto(new URL("/compare", mockOrigin).href);
    await mock.locator("#workspace .control-actions").waitFor();
    assert.equal(await links(mock).count(), 0);
    assert.deepEqual(mockExports, []);
    await mock.close();
  }
  console.log("Eight attachment downloads matched site, run, evaluated UTC range and CSV bytes; no automatic CSV fetches or exports on local import." +
    (mockOrigin ? " Mock-mode result has no producer CSV links." : " Mock-mode origin omitted."), browser.version());
} finally { await browser.close(); }
