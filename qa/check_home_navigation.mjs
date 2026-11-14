import assert from "node:assert/strict";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of the production frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

try {
  for (const width of [320, 375, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 568 }, reducedMotion: "reduce" });
    await page.goto(new URL("/", origin).href);
    const menu = page.locator(".home-menu");
    const nav = page.locator("header nav");
    const mobile = width < 760;
    await page.waitForFunction(() => !document.querySelector(".language-switch select").disabled);
    assert.equal(await page.locator("#globe-site, .site-pin-key").count(), 0);
    assert.equal(await menu.isVisible(), mobile);
    if (mobile) {
      assert.equal(await nav.isVisible(), false);
      await menu.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute("href")), "/compare");
      await page.keyboard.press("Escape");
      assert.ok(await menu.evaluate(el => el === document.activeElement));
      await menu.click();
    }
    await nav.getByLabel("Language").selectOption("vi");
    assert.deepEqual(await nav.getByRole("link").allTextContents(),
      ["So sánh", "Giới thiệu", "Nguồn và phương pháp", "Thành viên", "Dữ liệu và nguồn tham khảo"]);
    for (const id of ["team", "about", "resources"]) {
      await nav.locator('a[href="#' + id + '"]').press("Enter");
      await page.waitForFunction(target => document.activeElement.id === target, id);
      if (mobile) {
        assert.equal(await menu.getAttribute("aria-expanded"), "false");
        await menu.click();
      }
    }
    await nav.getByRole("link", { name: "Nguồn và phương pháp" }).press("Enter");
    await page.waitForFunction(() => document.activeElement.id === "saved-model-source" &&
      document.activeElement.closest("details").open);
    assert.equal(new URL(page.url()).pathname, "/compare");
    assert.equal(await page.locator(".site-pin-key button").count(), 2);
    await page.locator("#globe-site").selectOption({ index: 1 });
    assert.ok(await page.locator(".globe-place").isVisible());
    await page.close();
  }
  console.log("Home navigation, keyboard focus and saved sources passed at 320, 375 and 1280 px.");
} finally { await browser.close(); }
