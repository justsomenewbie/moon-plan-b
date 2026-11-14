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
    const compare = page.locator('.hero-actions a[href="/compare"]');
    assert.equal(await compare.innerText(), "Compare");
    assert.equal(await nav.locator('a[href="/compare"]').count(), 0);
    await compare.press("Enter");
    await page.waitForURL(new URL("/compare", origin).href);
    await page.getByRole("heading", { name: "Comparison tool", exact: true }).waitFor();
    await page.goBack();
    const guideLink = page.locator('.hero-actions a[href="#home-guide"]');
    assert.equal(await page.locator(".hero-actions a").count(), 2);
    await guideLink.press("Enter");
    await page.waitForFunction(() => document.activeElement.id === "home-guide");
    const steps = page.locator("#home-guide details");
    assert.equal(await steps.getAttribute("open"), null);
    await steps.locator("summary").press("Enter");
    assert.deepEqual(await steps.locator("img").evaluateAll(async imgs => {
      await Promise.all(imgs.map(img => img.decode()));
      return imgs.map(img => [img.naturalWidth, img.src.split("/").pop()]);
    }), [1, 2, 3].map(i => [640, `plan-step-${i}-en.webp`]));
    await steps.getByRole("link").press("Enter");
    await page.waitForURL(url => url.pathname === "/plan" && url.searchParams.get("source") === "saved-b2");
    await page.locator(".plan-results tbody tr").first().waitFor();
    assert.equal(await page.locator(".plan-results tbody tr").count(), 23);
    assert.match(await page.locator(".plan-results tbody tr").first().innerText(), /Vikram.*162/s);
    await page.goBack();
    for (const mode of ["sites", "dates"]) {
      assert.ok(await page.locator(`#home-guide a[href="/plan?mode=${mode}"]`).isVisible());
    }
    assert.equal(await page.locator("#home-guide").getByRole("link", { name: "Orbit view" }).getAttribute("href"), "/orbit");
    assert.ok(await page.getByRole("img", { name: /Low sunlight reaches the left rim/ }).isVisible());
    await page.route("**/api/**", route => route.abort());
    await page.getByRole("link", { name: "Try the saved example" }).press("Enter");
    await page.waitForURL(url => url.pathname === "/compare" && url.hash === "#observed-week" &&
      url.searchParams.get("saved") === "2026-11-14T00:00:00Z");
    const week = page.locator("#observed-week");
    assert.equal(await week.getByLabel(/^Compare saved results/).inputValue(), "2026-11-14T00:00:00Z");
    for (const [name, hours] of [["Athena", "139 h"], ["Odysseus", "33 h"]]) {
      assert.equal(await week.getByRole("article").filter({ has: page.getByRole("heading", { name: new RegExp(name) }) }).locator(".week-hours").innerText(), hours);
    }
    const reading = week.locator(".week-reading");
    assert.match(await reading.innerText(), /33 h.*Odysseus.*139 h.*Athena/);
    await week.getByLabel(/^Compare saved results/).selectOption("2026-11-21T00:00:00Z");
    assert.match(await reading.innerText(), /168 h.*Odysseus.*168 h.*Athena/);
    await week.getByLabel(/^Compare saved results/).selectOption("im2_athena");
    assert.match(await reading.innerText(), /Athena.*139 h.*first week.*168 h.*second/);
    await page.goBack(); await page.goBack();
    await page.unroute("**/api/**");
    await page.goBack();
    await compare.waitFor();
    await page.waitForFunction(() => !document.querySelector(".language-switch select").disabled);
    assert.equal(await page.locator("#globe-site, .site-pin-key").count(), 0);
    assert.equal(await menu.isVisible(), mobile);
    if (mobile) {
      assert.equal(await nav.isVisible(), false);
      await menu.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute("href")), "#about");
      await page.keyboard.press("Escape");
      assert.ok(await menu.evaluate(el => el === document.activeElement));
      await menu.click();
    }
    await nav.getByLabel("Language").selectOption("vi");
    assert.equal(await compare.innerText(), "So sánh");
    assert.equal(await guideLink.innerText(), "Cách dùng Moon Plan B");
    assert.deepEqual(await nav.getByRole("link").allTextContents(),
      ["Giới thiệu", "Nguồn và phương pháp", "Thành viên", "Dữ liệu và nguồn tham khảo"]);
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
    assert.equal(await page.locator("#resources .resource-links a").count(), 3);
    assert.equal(new URL(page.url()).pathname, "/compare");
    const referenceGlobe = page.locator("#lunar-reference");
    assert.equal(await referenceGlobe.locator(".site-pin-key button").count(), 2);
    await referenceGlobe.locator("#globe-site").selectOption({ index: 1 });
    assert.ok(await referenceGlobe.locator(".globe-place").isVisible());
    await page.close();
  }
  console.log("Homepage Compare, saved example, keyboard navigation and sources passed at 320, 375 and 1280 px.");
} finally { await browser.close(); }
