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
    const primary = page.locator(".hero-actions .primary");
    assert.equal(await primary.innerText(), "Compare Athena and Odysseus");
    const guideLink = page.locator('.hero-actions a[href="#home-guide"]');
    assert.equal(await page.locator(".hero-actions a").count(), 2);
    await guideLink.press("Enter");
    await page.waitForFunction(() => document.activeElement.id === "home-guide");
    for (const mode of ["sites", "dates"]) {
      assert.ok(await page.locator(`#home-guide a[href="/plan?mode=${mode}"]`).isVisible());
    }
    assert.ok(await page.getByRole("img", { name: /Low sunlight reaches the left rim/ }).isVisible());
    await page.route("**/api/**", route => route.abort());
    await primary.press("Enter");
    await page.waitForURL(url => url.pathname === "/compare" && url.hash === "#observed-week" &&
      url.searchParams.get("saved") === "2026-11-14T00:00:00Z");
    const week = page.locator("#observed-week");
    assert.equal(await week.getByLabel(/^Compare saved results/).inputValue(), "2026-11-14T00:00:00Z");
    for (const [name, hours] of [["Athena", "139 h"], ["Odysseus", "33 h"]]) {
      assert.equal(await week.getByRole("article").filter({ has: page.getByRole("heading", { name: new RegExp(name) }) }).locator(".week-hours").innerText(), hours);
    }
    await page.unroute("**/api/**");
    await page.goBack();
    await primary.waitFor();
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
    assert.equal(await primary.innerText(), "So sánh Athena và Odysseus");
    assert.equal(await guideLink.innerText(), "Cách dùng Moon Plan B");
    const guide = page.locator("#home-guide");
    for (const [i, img] of (await guide.locator("img").all()).entries()) {
      await img.scrollIntoViewIfNeeded();
      await img.evaluate(el => el.decode());
      assert.equal(await img.getAttribute("src"), `/images/guide/plan-step-${i + 1}-vi.webp`);
    }
    assert.equal(await guide.locator("img").count(), 3);
    assert.equal(await page.locator("#resources .resource-links a").count(), 3);
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
    await page.waitForURL(url => url.pathname === "/compare");
    await page.waitForFunction(() => document.activeElement?.id === "saved-model-source" &&
      document.activeElement.closest("details")?.open);
    assert.equal(new URL(page.url()).pathname, "/compare");
    assert.equal(await page.locator("#resources").count(), 0);
    assert.equal(await page.locator('nav a[href="/#resources"]').count(), 1);
    assert.equal(await page.locator(".site-pin-key button").count(), 2);
    await page.locator("#globe-site").selectOption({ index: 1 });
    assert.ok(await page.locator(".globe-place").isVisible());
    await page.close();
  }
  console.log("Homepage example, saved hours, keyboard navigation and sources passed at 320, 375 and 1280 px.");
} finally { await browser.close(); }
