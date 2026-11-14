import assert from "node:assert/strict";

// Run B integration check. Uses bounded dataset/catalog GETs and the read-only comparison POST.
const origin = new URL(process.argv[2]).origin;
const run = "B_spice_pgda_bruteforce_2026_2030", from = "2026-11-14T00:00:00Z", to = "2026-11-15T00:00:00Z";
const requested = ["a3_haworth", "apollo11"]; // The producer ranks Apollo first here.
const bounds = { run_id: run, from, to, resolutionSeconds: "3600" };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const context = await browser.newContext({ serviceWorkers: "block", timezoneId: "Asia/Ho_Chi_Minh" });
  const reads = [], pairs = [], unexpected = [];
  await context.route("**/api/**", route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === "GET" && url.pathname === "/api/v1/dataset") reads.push(url);
    else if (req.method() === "POST" && url.pathname === "/api/v1/compare") pairs.push(req.postDataJSON());
    else if (req.method() !== "GET" || url.pathname !== "/api/v1/sites") {
      unexpected.push(req.method() + " " + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  const entry = await context.newPage();
  await entry.goto(origin + "/compare?" + new URLSearchParams(bounds));
  const panel = entry.locator("#terrain-pair");
  const ranks = p => p.getByRole("region", { name: "Pair comparison results" });
  await panel.locator("summary").click();
  await panel.locator('[name="pairFirstSite"] option[value="a3_haworth"]').waitFor({ state: "attached" });
  await panel.locator('[name="pairFirstSite"]').selectOption(requested[0]);
  await panel.locator('[name="pairSecondSite"]').selectOption(requested[1]);
  await panel.getByRole("button", { name: "Compare this pair" }).click();
  const link = ranks(entry).getByRole("link", { name: "Open this ranked pair in a new tab" });
  await link.waitFor();
  const pairMap = entry.locator("#pair-lunar-reference");
  const cards = ranks(entry).locator("article");
  assert.match(await cards.nth(0).innerText(), /0\.67416° latitude · 23\.47314° east longitude/);
  assert.match(await cards.nth(1).innerText(), /-86\.752966° latitude · 336\.328186° east longitude/);
  assert.match(await cards.nth(1).innerText(), /representative point/);
  for (const [index, longitude, latitude] of [[0, "23.47314", "0.67416"], [1, "336.328186", "-86.752966"]]) {
    const imagery = new URL(await cards.nth(index).getByRole("link", { name: "View this site in LROC imagery ↗" }).getAttribute("href"));
    assert.equal(imagery.host, "data.lroc.im-ldi.com");
    assert.deepEqual([imagery.searchParams.get("c_lon"), imagery.searchParams.get("c_lat")], [longitude, latitude]);
  }
  await ranks(entry).getByRole("button", { name: "Show this pair on the globe" }).click();
  await pairMap.locator("canvas:visible").waitFor();
  assert.equal(await pairMap.locator(".site-pin button").count(), 2);
  for (const [label, latitude] of [[/Apollo 11/, /0\.67416°/], [/Haworth/, /-86\.752966°/]]) {
    await pairMap.locator(".site-pin-key button").filter({ hasText: label }).click();
    assert.match(await pairMap.locator(".globe-place").innerText(), latitude);
  }
  await pairMap.getByRole("button", { name: "Zoom in" }).click();
  assert.match(await pairMap.locator(".globe-center").innerText(), /2×/);
  assert.equal(await pairMap.locator(".globe-sunlight, .site-week-readings").count(), 0);
  assert.match(await entry.locator("#lunar-reference .site-pin-key").innerText(), /Odysseus/);
  const headings = await ranks(entry).locator("article h3").allTextContents();
  assert.equal(headings.length, 2);
  assert.match(headings[0], /Apollo 11/);
  assert.match(headings[1], /Haworth/);
  const url = new URL(await link.getAttribute("href"), entry.url());
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, "/compare");
  assert.equal(url.hash, "#terrain-pair");
  assert.deepEqual(Object.fromEntries(url.searchParams), { ...bounds, site_ids: requested.join(",") });
  const aggregateResponse = context.waitForEvent("response", r => {
    const u = new URL(r.url());
    return u.pathname === "/api/v1/dataset" && u.searchParams.get("site_ids") === requested.join(",");
  });
  const [shared, response] = await Promise.all([context.waitForEvent("page"), aggregateResponse, link.click()]);
  const raw = await response.body();
  const observed = JSON.parse(raw);
  assert.deepEqual(observed.sites.map(s => s.id), requested);
  assert.equal(observed.run.run_id, run);
  for (const reload of [false, true]) {
    if (reload) await shared.reload();
    await ranks(shared).waitFor();
    assert.notEqual(await shared.locator("#terrain-pair").getAttribute("open"), null);
    assert.deepEqual(await ranks(shared).locator("article h3").allTextContents(), headings);
    assert.equal(reads.at(-1).searchParams.get("site_ids"), requested.join(","));
    assert.equal(pairs.length, reload ? 3 : 2);
    assert.deepEqual(pairs.at(-1).site_ids, requested);
    assert.deepEqual([pairs.at(-1).run_id, pairs.at(-1).start, pairs.at(-1).end], [run, from, to]);
  }

  await shared.getByLabel("Language", { exact: true }).first().selectOption("vi");
  const translated = shared.getByRole("link", { name: "Mở kết quả xếp hạng cặp này trong thẻ mới" });
  await translated.waitFor();
  assert.equal(new URL(await translated.getAttribute("href"), shared.url()).href, url.href);
  await shared.locator(".language-switch select").first().selectOption("en");

  const selector = shared.locator("#terrain-observations select");
  await selector.selectOption(requested[1]);
  const observation = shared.getByRole("link", { name: "Open selected observation in a new tab" });
  const obsUrl = new URL(await observation.getAttribute("href"), shared.url());
  assert.equal(obsUrl.searchParams.get("site_ids"), requested.join(","));
  assert.equal(obsUrl.searchParams.get("view_site"), requested[1]);
  assert.equal(obsUrl.hash, "#terrain-observations");
  const [view] = await Promise.all([context.waitForEvent("page"), observation.click()]);
  await view.locator("#terrain-sample-utc").waitFor();
  assert.equal(await view.locator("#terrain-observations select").inputValue(), requested[1]);
  assert.equal(await ranks(view).count(), 0);
  assert.equal(pairs.length, 3);

  // Recovery from the exact producer bytes must remain local, even if the bookmark had requested ranks.
  await shared.route("**/api/v1/dataset?*", route => route.fulfill({ status: 404, json: { detail: "Controlled pair outage." } }));
  await shared.goto(url.href);
  const error = shared.locator("#data-error");
  await error.getByRole("button", { name: "Import the correct dataset" }).click();
  await shared.locator("#import-dialog input[type=file]").setInputFiles({ name: "pair.json", mimeType: "application/json", buffer: raw });
  await shared.getByRole("status").filter({ hasText: "Dataset imported locally" }).first().waitFor();
  assert.equal(await shared.locator("#workspace > .week-sites article").count(), 2);
  assert.equal(await shared.locator("#terrain-pair").count(), 0);
  assert.equal(pairs.length, 3);

  // Changing the choice must remove the previous result and both live pins immediately.
  await panel.locator('[name="pairFirstSite"]').selectOption("im1_odysseus");
  assert.equal(await pairMap.count(), 0);
  assert.equal(await ranks(entry).count(), 0);
  assert.match(await entry.locator("#lunar-reference .site-pin-key").innerText(), /Athena/);

  for (const [name, value] of [["site_id", requested[0]], ["site_ids", requested.join(",")], ["site_ids", "apollo11,apollo11"]]) {
    const malformed = new URL(url);
    if (value === "apollo11,apollo11") malformed.searchParams.set(name, value);
    else malformed.searchParams.append(name, value);
    const readCount = reads.length;
    await entry.goto(malformed.href);
    await entry.locator("#data-error").waitFor();
    assert.equal(reads.length, readCount);
    assert.equal(pairs.length, 3);
  }
  assert.deepEqual(unexpected, []);
  console.log("Ranked pair survived sharing and reload; observations, local recovery and invalid links issued no unsolicited comparison.");
} finally { await browser.close(); }
