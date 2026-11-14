import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Run against a live-configured production frontend. Submits one three-hour custom-site request.
const origin = new URL(process.argv[2]).origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const context = await browser.newContext({ timezoneId: "UTC", reducedMotion: "reduce" });
  const urls = [];
  const pageErrors = [];
  const initiators = {};
  const apiCounts = {};
  let workerResponses = 0;
  const failed = [];
  const workerTargets = [];
  const targets = await browser.newBrowserCDPSession();
  targets.on("Target.targetCreated", ({ targetInfo }) => {
    if (["worker", "shared_worker", "service_worker"].includes(targetInfo.type)) workerTargets.push(targetInfo.type);
  });
  await targets.send("Target.setDiscoverTargets", { discover: true });
  context.on("request", request => urls.push(request.url()));
  context.on("response", response => {
    if (response.fromServiceWorker()) workerResponses++;
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/")) {
      const route = path.replace(/\/jobs\/[^/]+$/, "/jobs/{id}");
      const key = [response.request().method(), route, response.status()].join(" ");
      apiCounts[key] = (apiCounts[key] || 0) + 1;
    }
  });
  context.on("requestfailed", request => failed.push(request.failure()?.errorText));
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  const sockets = [];
  page.on("websocket", socket => sockets.push(socket.url()));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const cdpUrls = [];
  cdp.on("Network.requestWillBeSent", ({ initiator, request }) => {
    cdpUrls.push(request.url);
    initiators[initiator.type] = (initiators[initiator.type] || 0) + 1;
  });

  const terrain = page.getByRole("heading", { name: "Sun and Earth visibility above the terrain horizon" });
  await page.goto(new URL("/compare", origin).href);
  await terrain.waitFor();
  assert.equal(await page.locator(".terrain-result article").count(), 2);

  // A local 404 does not trigger automatic retries. Exercise the visible Retry button.
  await page.route("**/api/v1/dataset?*", route => route.fulfill({ status: 404, json: {detail: "QA retry check"} }), { times: 1 });
  await page.reload();
  await page.getByRole("button", { name: "Retry API request", exact: true }).click();
  await terrain.waitFor();

  const imports = ["fixtures/normal.json", "fixtures/partial.json", "fixtures/missing.json", "fixtures/crossing_wrap.json",
    "evidence/odysseus-hour-gap/control.json", "evidence/odysseus-hour-gap/gap.json",
    "evidence/odysseus-athena-hour-gap/control.json", "evidence/odysseus-athena-hour-gap/gap.json",
    "../frontend/public/data/demo.json"];
  const slider = page.getByRole("slider", { name: "Timeline sample" });
  for (const entry of imports) {
    const file = fileURLToPath(new URL(entry, import.meta.url));
    const data = JSON.parse(await readFile(file, "utf8"));
    await page.getByLabel("Import JSON dataset").setInputFiles(file);
    await page.locator("#sources").getByText(data.datasetId, { exact: true }).waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Compare sites", exact: true }).click();
    const primary = page.getByLabel(/^Primary site/);
    const alt = page.getByLabel(/^Alternative site/);
    const first = data.scenarios[0];
    assert.equal(await primary.inputValue(), first.id);
    const other = data.scenarios.find(s => s.siteId !== first.siteId && s.startUtc === first.startUtc);
    if (other) {
      assert.equal(await alt.inputValue(), other.id);
      await primary.selectOption(other.id);
      assert.equal(await alt.inputValue(), first.id);
    } else {
      assert.ok(await alt.isDisabled());
    }
    if (first.samples.length) {
      const before = await slider.inputValue();
      await slider.press("ArrowRight");
      assert.notEqual(await slider.inputValue(), before);
    } else {
      assert.ok(await slider.isDisabled());
    }
  }
  await page.getByRole("button", { name: "Compare dates", exact: true }).click();
  await page.getByRole("combobox", { name: /^Site\b/ }).selectOption("ridge");
  await page.getByLabel("Primary window").selectOption("ridge-1");
  const compared = page.getByLabel("Compare with");
  await compared.selectOption("ridge-3");
  assert.equal(await compared.inputValue(), "ridge-3");
  await slider.press("ArrowRight");

  await page.getByText("Request observation windows", { exact: true }).click();
  await page.getByLabel("From · UTC").fill("2026-11-14T00:00");
  await page.getByLabel("To · UTC").fill("2026-11-14T03:00");
  await page.getByText("Request a custom lunar location", { exact: true }).click();
  await page.getByLabel("Planetocentric latitude · degrees").fill("-84.7906");
  await page.getByLabel("East longitude · degrees").fill("29.1957");
  await page.getByLabel("Observer height above surface · m").fill("2");
  const receipt = page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/jobs" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Request calculation" }).click();
  const accepted = await receipt;
  assert.ok([200, 202].includes(accepted.status()));
  const job = await accepted.json();
  await page.getByRole("button", { name: "Open job results" }).click({ timeout: 90000 });
  await terrain.waitFor();
  assert.equal(await page.locator(".terrain-result article").count(), 1);
  assert.equal(new URL(page.url()).searchParams.get("site_id"), job.site_id);
  await page.reload();
  await terrain.waitFor();
  assert.equal(await page.locator(".terrain-result article").count(), 1);
  await page.getByRole("link", { name: "API explorer", exact: true }).click();
  await page.frameLocator("iframe").locator(".swagger-ui .info .title").filter({ hasText: "Lunar Landing Site Navigator API" }).waitFor();
  await page.waitForLoadState("networkidle");

  assert.equal(apiCounts["POST /api/v1/jobs " + accepted.status()], 1);
  const expectedRoutes = ["/api/v1/dataset", "/api/v1/capabilities", "/api/v1/jobs/{id}", "/api/v1/openapi.json"];
  for (const route of expectedRoutes) assert.ok(apiCounts["GET " + route + " 200"] > 0, route);
  assert.equal(apiCounts["GET /api/v1/dataset 404"], 1);
  // Count attempted requests (including redirects and failures), not just completed responses.
  const networkUrls = [...urls, ...cdpUrls, ...sockets].map(url => new URL(url)).filter(url => /^(https?|wss?):$/.test(url.protocol));
  const origins = [...new Set(networkUrls.map(url => url.origin.replace(/^ws/, "http")))];
  assert.deepEqual(origins, [origin], "unexpected network destinations");
  const proxyPaths = networkUrls.filter(url => url.pathname.startsWith("/api/")).map(url => url.pathname.replace(/\/jobs\/j_[a-zA-Z0-9]+$/, "/jobs/{id}"));
  assert.deepEqual([...new Set(proxyPaths)].sort(), [...expectedRoutes, "/api/v1/jobs"].sort(), "unexpected API route");
  assert.deepEqual(workerTargets, [], "review worker traffic for this build");
  assert.equal(workerResponses, 0);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ chromium: browser.version(), utc: new Date().toISOString(), imports: imports.length,
    requests: urls.length, initiators, apiCounts, cachedJob: job.cached,
    sockets: sockets.length, workerTargets, workerResponses, failed, externalOrigins: origins.filter(value => value !== origin) }, null, 2));
} finally { await browser.close(); }
