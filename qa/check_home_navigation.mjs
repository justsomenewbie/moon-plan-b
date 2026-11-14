import assert from "node:assert/strict";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of the production frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

try {
  for (const width of [320, 375, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 568 }, reducedMotion: "reduce" });
    if (width === 320) {
      const hydration = Promise.withResolvers();
      await page.route("**/_next/static/**/*.js*", async route => { await hydration.promise; await route.continue(); });
      try {
        await page.goto(new URL("/", origin).href, { waitUntil: "commit" });
        const initialSelect = page.locator(".home-comparison-example select");
        await initialSelect.waitFor({ state: "attached" });
        assert.equal(await initialSelect.isDisabled(), true);
      } finally {
        hydration.resolve();
      }
      await page.unrouteAll({ behavior: "wait" });
    } else {
      await page.goto(new URL("/", origin).href, { waitUntil: "domcontentloaded" });
    }
    const menu = page.locator(".home-menu");
    const nav = page.locator("header nav");
    const mobile = width < 760;
    await page.waitForFunction(() => !document.querySelector(".language-switch select").disabled);
    const compare = page.locator('.hero-actions a[href="/compare"]');
    assert.match(await compare.innerText(), /Open comparison tool/);
    const plan = page.locator('.hero-actions a[href="/plan"]');
    assert.equal(await plan.innerText(), "Plan a lunar visit");
    await plan.press("Enter");
    await page.waitForURL(new URL("/plan", origin).href);
    await page.goBack();
    assert.equal(await nav.locator('a[href="/compare"]').count(), 0);
    await compare.press("Enter");
    await page.waitForURL(new URL("/compare", origin).href);
    await page.getByRole("heading", { name: "Comparison tool", exact: true }).waitFor();
    await page.goBack();
    const guideLink = page.locator('.hero-actions a[href="#home-guide"]');
    assert.equal(await page.locator(".hero-actions a").count(), 3);
    await guideLink.press("Enter");
    await page.waitForFunction(() => document.activeElement.id === "home-guide");
    const steps = page.locator("#home-guide details");
    const firstStep = steps.locator("li").first();
    assert.equal(await firstStep.isVisible(), true);
    await steps.locator("summary").press("Enter");
    assert.equal(await firstStep.isVisible(), false);
    await steps.locator("summary").press("Enter");
    assert.equal(await firstStep.isVisible(), true);
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
    const example = page.getByRole("region", { name: "How do I compare two sites or two weeks?" });
    const demoSelect = example.getByRole("combobox", { name: "Compare saved results" });
    const exampleLink = example.getByRole("link", { name: "Open this comparison" });
    for (const [value, hours] of [
      ["2026-11-14T00:00:00Z", [33, 139]], ["im1_odysseus", [33, 168]],
      ["im2_athena", [139, 168]], ["2026-11-21T00:00:00Z", [168, 168]],
    ]) {
      await demoSelect.selectOption(value);
      assert.deepEqual(await example.locator("li strong").allTextContents(), hours.map(h => h + " of 168 h"));
      assert.equal(new URL(await exampleLink.getAttribute("href"), origin).searchParams.get("saved"), value);
      for (const [i, bar] of (await example.locator(".week-track span").all()).entries()) {
        const ratio = await bar.evaluate(el => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width);
        assert.ok(Math.abs(ratio - hours[i] / 168) < .005);
      }
    }
    await demoSelect.selectOption("2026-11-14T00:00:00Z");
    await exampleLink.press("Enter");
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
    assert.match(await compare.innerText(), /Mở công cụ so sánh/);
    assert.equal(await plan.innerText(), "Lập kế hoạch cho chuyến đi tới Mặt Trăng");
    assert.equal(await guideLink.innerText(), "Cách dùng Moon Plan B");
    assert.match(await steps.locator("summary").innerText(), /ngày tôi chọn/);
    assert.equal(await firstStep.isVisible(), true);
    const viDemo = page.getByRole("region", { name: "Làm sao so sánh hai địa điểm hoặc hai tuần?" });
    await viDemo.getByRole("combobox", { name: "So sánh kết quả đã lưu" }).selectOption("im1_odysseus");
    assert.deepEqual(await viDemo.locator("li strong").allTextContents(), ["33 trên 168 giờ", "168 trên 168 giờ"]);
    const viHref = await viDemo.getByRole("link", { name: "Mở kết quả so sánh này" }).getAttribute("href");
    assert.equal(new URL(viHref, origin).searchParams.get("saved"), "im1_odysseus");
    await page.getByRole("button", { name: "Hướng dẫn của phi hành gia", exact: true }).click();
    const panel = page.locator("aside:popover-open");
    await panel.getByText("Trong kết quả đã chọn, cả Mặt Trời và Trái Đất cùng xuất hiện trong bao lâu?", { exact: true }).click();
    assert.deepEqual(await panel.locator("details[open] li strong").allTextContents(), ["Odysseus · IM-1 · 33 h", "Odysseus · IM-1 · 168 h"]);
    assert.equal(await panel.getByRole("link", { name: "Đến phần so sánh kết quả đã lưu" }).getAttribute("href"), viHref);
    await page.keyboard.press("Escape");
    const pictures = steps.locator("li img");
    assert.deepEqual(await pictures.evaluateAll(imgs => imgs.map(img => img.src.split("/").pop())),
      [1, 2, 3].map(i => `plan-step-${i}-vi.webp`));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
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
