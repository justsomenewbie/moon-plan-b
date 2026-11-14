import assert from "node:assert/strict";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the origin of a live-mode frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

function windowOn(day, pin = false) {
  const date = "2026-01-0" + day;
  const spec = { run: "qa-day-" + day, start: date + "T00:00:00Z", at: date + "T02:00:00Z", end: date + "T04:00:00Z" };
  const url = new URL("/compare", origin);
  url.search = new URLSearchParams({ from: spec.start, to: spec.end, resolutionSeconds: "7200", run_id: spec.run });
  if (pin) {
    url.searchParams.set("view_site", "im2_athena");
    url.searchParams.set("at", spec.at);
  }
  return { ...spec, url: url.href };
}

async function exercise(lateSuccess) {
  const missing = windowOn(3), latest = windowOn(2, true), initial = windowOn(1);
  const page = await browser.newPage({ serviceWorkers: "block", timezoneId: "UTC" });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  // Seed same-document history before hydration, then traverse it with the browser Back button.
  await page.addInitScript(([first, second, third]) => {
    history.replaceState(null, "", first);
    history.pushState(null, "", second);
    history.pushState(null, "", third);
  }, [missing.url, latest.url, initial.url]);
  let allowRecovery = false;
  const held = Promise.withResolvers();
  await page.route("**/api/v1/dataset?*", async route => {
    const run = new URL(route.request().url()).searchParams.get("run_id");
    requests.push(run);
    if (run === initial.run) {
      await held.promise;
      if (lateSuccess) await route.fulfill({ json: terrainFixture(initial) });
      else await route.fulfill({ status: 404, json: { detail: "Obsolete response" } });
    } else if (run === latest.run) {
      await route.fulfill({ json: terrainFixture(latest) });
    } else {
      assert.equal(run, missing.run);
      await route.fulfill(allowRecovery ? { json: terrainFixture(missing) } :
        { status: 404, json: { detail: "Current window unavailable" } });
    }
  });
  const busy = page.locator("#workspace[aria-busy=true]");
  const workspace = page.locator("#workspace.terrain-result");
  const saved = page.getByRole("combobox", { name: "Compare saved results" });
  const load = page.getByRole("button", { name: "Load windows", exact: true });
  const importButton = page.getByRole("button", { name: "Import data", exact: true });
  async function checkLoaded(spec, site, utc) {
    await workspace.getByText(spec.run, { exact: true }).waitFor({ state: "attached" });
    assert.equal(await page.getByRole("combobox", { name: "Observation site" }).inputValue(), site);
    assert.equal(await page.locator("#terrain-sample-utc").getAttribute("datetime"), utc);
    assert.equal(await workspace.locator(":scope > p time").first().getAttribute("datetime"), spec.start);
    assert.equal(await busy.count(), 0);
    assert.ok(await importButton.isEnabled());
    assert.ok(await load.isEnabled());
    assert.equal(await page.locator("#data-error").count(), 0);
    assert.equal(page.url(), spec.url);
  }
  try {
    const firstRequest = page.waitForRequest(req => new URL(req.url()).searchParams.get("run_id") === initial.run);
    await Promise.all([firstRequest, page.goto(new URL("/compare", origin).href, { waitUntil: "domcontentloaded" })]);
    await busy.waitFor();
    await page.getByText("Request observation windows", { exact: true }).click();
    assert.ok(await load.isDisabled());
    assert.ok(await importButton.isDisabled());
    assert.equal(await workspace.count(), 0);
    await saved.selectOption("im2_athena");
    const savedCard = page.locator("#observed-week");
    assert.equal(await savedCard.locator(".week-sites article").count(), 2);
    for (const row of await savedCard.locator(".week-sites article").all())
      assert.match(await row.innerText(), /Athena/);
    assert.equal(await busy.getByRole("heading", { name: "Opening the dataset" }).count(), 1);
    await page.goBack();  // Undo saved selection; the initial load is still held.
    assert.equal(page.url(), initial.url);
    await page.goBack();  // Load the second date and its pinned Athena sample first.
    await checkLoaded(latest, "im2_athena", latest.at);
    const responseHandled = page.waitForEvent("requestfinished", req => new URL(req.url()).searchParams.get("run_id") === initial.run);
    held.resolve();
    await responseHandled;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await checkLoaded(latest, "im2_athena", latest.at);
    await page.goBack();  // Third date has no pinned sample; its first response fails.
    await page.locator("#data-error").getByText("Current window unavailable").waitFor();
    assert.equal(page.url(), missing.url);
    assert.equal(await workspace.count(), 0, "A failed history destination must not display the previous date's live result");
    assert.equal(await savedCard.locator(".week-sites article").count(), 2);
    allowRecovery = true;
    await page.getByRole("button", { name: "Retry API request", exact: true }).click();
    await checkLoaded(missing, "im1_odysseus", missing.start);
    assert.deepEqual(requests, [initial.run, latest.run, missing.run, missing.run]);
    assert.deepEqual(errors, []);
  } finally { held.resolve(); await page.close(); }
}

try {
  for (const lateSuccess of [true, false]) await exercise(lateSuccess);
  console.log("Pending selection, late success/error and failed history recovery passed in Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
