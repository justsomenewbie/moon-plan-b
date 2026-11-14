import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running production frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, timezoneId: "UTC" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/compare", origin).href);
  const globe = page.locator("#lunar-reference");
  const map = globe.getByRole("img", { name: "Lunar surface globe" });
  await map.waitFor();
  await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();
  const fixture = new URL("./evidence/odysseus-athena-hour-gap/gap.json", import.meta.url);
  await page.getByLabel("Import JSON dataset").setInputFiles(fileURLToPath(fixture));
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  const primary = page.getByLabel(/^Primary site/);
  const alternative = page.getByLabel(/^Alternative site/);
  await primary.selectOption("athena-jan07");
  await page.getByText("Inspect exact samples", { exact: true }).click();
  const tables = page.getByRole("table", { name: /^(Primary|Alternative) ·/ });
  const paths = page.locator(".timeline-svg path.plot-line");
  const slider = page.getByRole("slider", { name: "Timeline sample" });
  await slider.press("Home");
  await slider.press("ArrowRight");

  async function comparison() {
    return {
      primary: await primary.inputValue(), alternative: await alternative.inputValue(),
      tables: await tables.allInnerTexts(),
      paths: await paths.evaluateAll(lines => lines.map(line => line.getAttribute("d"))),
      clock: await page.locator(".sample-time").innerText(),
    };
  }
  const baseline = await comparison();
  assert.equal(baseline.primary, "athena-jan07");
  assert.equal(baseline.alternative, "odysseus-jan07");
  assert.equal(baseline.tables.length, 2);
  assert.equal(baseline.paths.length, 4);
  assert.ok(baseline.paths.every(path => path?.startsWith("M")));
  assert.match(baseline.clock, /Primary: .*01:00 UTC · Alternative: .*01:00 UTC$/);

  // The mock service worker handles image requests before page.route can inject either texture failure.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  for (const fault of ["texture-404", "invalid-jpeg", "no-2d-context"]) {
    await globe.getByRole("button", { name: "Return to photograph" }).click();
    if (fault === "no-2d-context") {
      await page.evaluate(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (type === "2d" && this.closest("#lunar-reference")) {
            HTMLCanvasElement.prototype.getContext = original;
            return null;
          }
          return original.call(this, type, ...args);
        };
      });
    } else {
      await page.route("**/images/lroc-color-2k.jpg", route => route.fulfill(
        fault === "texture-404" ? { status: 404, body: "" } :
          { status: 200, contentType: "image/jpeg", body: "Invalid JPEG" }
      ), { times: 1 });
    }
    await globe.getByRole("button", { name: "Rotate the Moon" }).click();
    const retry = globe.getByRole("button", { name: "Retry globe" });
    await retry.waitFor();
    assert.match(await globe.getByRole("status").innerText(), /Globe unavailable/);
    const photo = globe.getByRole("img", { name: /^Photographic mosaic/ });
    assert.ok(await photo.isVisible());
    assert.ok(await photo.evaluate(img => img.complete && img.naturalWidth > 0));
    assert.deepEqual(await comparison(), baseline);
    await slider.press("ArrowRight");
    assert.match(await page.locator(".sample-time").innerText(), /Primary: .*03:00 UTC · Alternative: .*03:00 UTC$/);
    await slider.press("ArrowLeft");
    await retry.click();
    await map.waitFor();
    assert.deepEqual(await comparison(), baseline);
    console.log(fault, "passed");
  }
  assert.deepEqual(errors, []);
  console.log("Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
