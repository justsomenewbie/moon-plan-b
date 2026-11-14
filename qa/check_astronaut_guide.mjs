import assert from "node:assert/strict";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running Moon Plan B frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(origin);
  const launcher = page.getByRole("button", { name: "Astronaut guide", exact: true });
  const panel = page.locator("aside[popover]");
  await launcher.focus();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "visible" });
  const questions = panel.locator("summary");
  assert.equal(await questions.count(), 3);
  for (const [index, expected] of ["choose a week", "no live feed", "no signal-strength estimate"].entries()) {
    await questions.nth(index).click();
    const answer = panel.locator("details[open] p");
    assert.equal(await answer.count(), 1);
    assert.ok((await answer.textContent()).includes(expected));
  }
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.ok(await launcher.evaluate(button => button === document.activeElement));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
  const viLauncher = page.getByRole("button", { name: "Hướng dẫn của phi hành gia", exact: true });
  await viLauncher.click();
  await panel.getByText("Bạn muốn tìm hiểu điều gì?").waitFor();
  await questions.first().click();
  const box = await panel.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 568);
  assert.equal(await viLauncher.locator("span").evaluate(el => getComputedStyle(el).animationName), "none");
  await panel.getByRole("link").click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).hash, "#observed-week");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "observed-week");
  await viLauncher.click();
  await panel.waitFor({ state: "visible" });
  await panel.getByRole("button", { name: "Đóng hướng dẫn của phi hành gia" }).click();
  await panel.waitFor({ state: "hidden" });
  await page.emulateMedia({ media: "print" });
  assert.equal(await viLauncher.isVisible(), false);
  console.log("Passed EN/VI question and answer flows, keyboard dismissal, saved-result link, 320px layout, reduced motion and print.");
} finally {
  await browser.close();
}
