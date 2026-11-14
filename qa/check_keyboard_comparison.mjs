import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { terrainFixture } from "./browser-terrain-fixture.mjs";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a live-mode production frontend.");
const gap = fileURLToPath(new URL("./evidence/odysseus-athena-hour-gap/gap.json", import.meta.url));
const spec = { run: "keyboard-qa", start: "2026-01-02T00:00:00Z", at: "2026-01-02T02:00:00Z", end: "2026-01-02T04:00:00Z" };
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

try {
  const page = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: "reduce", timezoneId: "UTC" });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  let recover = false;
  await page.route("**/api/v1/dataset?*", async route => {
    requests.push(route.request().url());
    await route.fulfill(recover ? { json: terrainFixture(spec) } : { status: 404, json: { detail: "QA fixture unavailable" } });
  });
  const press = key => page.keyboard.press(key);
  async function tabTo(control, indicator = control) {
    for (let i = 0; i < 120; i++) {
      if (await control.evaluate(el => el === document.activeElement)) {
        const visible = await indicator.evaluate(el => {
          const style = getComputedStyle(el), r = el.getBoundingClientRect();
          return parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none" &&
            r.right > 0 && r.left < innerWidth && r.top < innerHeight && r.bottom > 0;
        });
        assert.ok(visible, "Focused control has a visible indicator inside the viewport: " + control);
        return;
      }
      await press("Tab");
    }
    assert.fail("Cannot reach with Tab: " + control);
  }

  const url = new URL("/compare", origin);
  url.search = new URLSearchParams({ from: spec.start, to: spec.end, resolutionSeconds: "7200", run_id: spec.run });
  await page.goto(url.href);
  const alert = page.locator("#data-error");
  await alert.waitFor();
  await tabTo(page.getByRole("link", { name: "Skip to comparison" }));
  await press("Enter");
  assert.ok(await alert.evaluate(el => document.activeElement === el));
  await tabTo(alert.getByRole("button", { name: "Retry API request" }));
  const attempts = requests.length;
  recover = true;
  await press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches("main.terrain-result"));
  assert.ok(await page.locator("#terrain-title").evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }), "The result heading is visible after keyboard retry");
  assert.equal(requests.length, attempts + 1);
  assert.equal(new Set(requests).size, 1);

  // A fresh visit starts tab order at the top of the page.
  await page.goto(url.href);
  const opener = page.getByRole("button", { name: "Import data", exact: true, disabled: false });
  await tabTo(opener);
  await press("Enter");
  const dialog = page.getByRole("dialog", { name: "Import a comparison dataset" });
  await dialog.waitFor();
  assert.ok(await dialog.getByRole("heading").evaluate(el => el === document.activeElement));
  const input = dialog.getByLabel("Import JSON dataset");
  await tabTo(input, dialog.locator("label.import-picker"));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), press("Enter")]);
  await chooser.setFiles(gap);
  await page.waitForFunction(() => document.activeElement?.matches("main.workspace"));
  await tabTo(page.getByRole("button", { name: "Compare sites", exact: true }));
  await press("Enter");
  const primary = page.getByRole("combobox", { name: "Primary site" });
  await tabTo(primary);
  await press("a");
  await page.waitForFunction(() => document.activeElement?.value === "athena-jan07");
  assert.equal(await page.getByRole("combobox", { name: "Alternative site" }).inputValue(), "odysseus-jan07");
  const slider = page.getByRole("slider", { name: "Timeline sample" });
  await tabTo(slider);
  assert.ok(await page.getByRole("button", { name: "Play timeline" }).isDisabled());
  await press("Home");
  for (const [key, hour] of [["ArrowRight", "01:00"], ["ArrowRight", "03:00"], ["ArrowLeft", "01:00"]]) {
    await press(key);
    const accessible = await slider.getAttribute("aria-valuetext");
    assert.ok(accessible.startsWith(hour === "01:00" ? "1 hour elapsed." : "3 hours elapsed."), accessible);
    for (const clocks of [accessible, await page.locator(".sample-time").innerText()]) {
      assert.equal(clocks.split(hour + " UTC").length - 1, 2, clocks);
    }
  }
  await tabTo(page.locator("details summary").filter({ hasText: "Inspect exact samples" }));
  await press("Enter");
  const regions = page.locator(".sample-table");
  for (const [i, expectedRows] of [4, 5].entries()) {
    const region = regions.nth(i);
    await tabTo(region);
    assert.equal(await region.locator("tbody tr").count(), expectedRows);
    await press("ArrowRight");
    await page.waitForFunction(index => document.querySelectorAll(".sample-table")[index].scrollLeft > 0, i);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log("Keyboard retry, dialog, site selection and dual UTC clocks passed at 320 CSS px under reduced motion.", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
