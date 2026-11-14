import assert from "node:assert/strict";

const origin = new URL(process.argv[2]).origin;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

async function zoom(page, want) {
  await page.waitForFunction(expected => {
    const text = document.querySelector(".globe-center")?.textContent ?? "";
    const amount = Number(/([0-9.]+)×$/.exec(text)?.[1]);
    return expected === "partial" ? amount > 1 && amount < 4 : amount === expected;
  }, want);
}

try {
  for (const route of ["/", "/compare"]) {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto(origin + route);
    const globe = page.locator("#lunar-reference"), surface = globe.locator("canvas");
    await surface.waitFor();
    await surface.focus();
    await surface.press("+"); await zoom(page, 2);
    await surface.press("+"); await zoom(page, 4);
    assert(await globe.getByRole("button", { name: "Zoom in", exact: true }).isDisabled());
    await surface.press("-"); await zoom(page, 2);
    await globe.getByRole("button", { name: "Reset view" }).click(); await zoom(page, 1);
    await surface.hover();
    await page.mouse.wheel(0, -100); await zoom(page, "partial");
    await page.mouse.wheel(0, 400); await zoom(page, 1);
    assert(await globe.locator('a[href="https://svs.gsfc.nasa.gov/4720/"]').isVisible());
    await globe.getByRole("button", { name: "Return to photograph" }).click();
    assert.equal(await globe.locator("canvas").count(), 0);
    assert(await globe.locator('a[href="https://svs.gsfc.nasa.gov/5001/"]').isVisible());
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  await page.goto(origin);
  const surface = page.locator("#lunar-reference canvas");
  await surface.waitFor(); await surface.scrollIntoViewIfNeeded();
  const rect = await surface.boundingBox(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  const session = await page.context().newCDPSession(page);
  const touches = (type, span) => session.send("Input.dispatchTouchEvent", {
    type, touchPoints: span ? [{ x: x - span, y, id: 1 }, { x: x + span, y, id: 2 }] : [],
  });
  await touches("touchStart", 25);
  await touches("touchMove", 50); await zoom(page, 2);
  await touches("touchMove", 110); await zoom(page, 4);
  await touches("touchMove", 18); await zoom(page, 1);
  await touches("touchEnd");
  assert.equal(await page.evaluate(() => visualViewport.scale), 1);
  await page.close();
  console.log("Wheel and focused keyboard zoom work on home and comparison globes. Mobile pinch is bounded to 1–4× and the NASA credits survive the photo switch.");
} finally { await browser.close(); }
