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
  await page.clock.setFixedTime(new Date("2026-11-15T05:37:00Z"));
  await page.goto(new URL("/compare", origin).href);
  const launcher = page.getByRole("button", { name: "Astronaut guide", exact: true });
  const panel = page.locator("aside[popover]");
  async function checkGreeting(locale) {
    const greeting = panel.locator(":scope > p").first();
    const invitation = locale === "en" ? "What can I help you explore?" : "Bạn muốn mình giúp tìm hiểu điều gì?";
    const limit = locale === "en" ? "I don’t have live measurements from the Moon." : "Mình chưa có số liệu đo trực tiếp từ Mặt Trăng.";
    assert.deepEqual((await greeting.innerText()).split("\n"), [invitation, limit]);
    assert.ok(await greeting.evaluate(el => el.previousElementSibling?.tagName === "HEADER"));
  }
  const animations = () => launcher.evaluate(el => el.getAnimations({ subtree: true })
    .filter(animation => animation instanceof CSSAnimation)
    .map(animation => animation.effect.getTiming().duration).sort((a, b) => a - b));
  await page.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
  assert.deepEqual(await animations(), [9000]);
  const motionPause = page.getByRole("checkbox", { name: "Pause sky and astronaut motion" });
  await motionPause.check();
  assert.deepEqual(await animations(), []);
  await motionPause.uncheck();
  assert.deepEqual(await animations(), [9000]);
  await launcher.focus();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "visible" });
  assert.deepEqual(await animations(), []);
  await panel.getByText("2026-11-15 05:00:00 UTC").waitFor();
  await checkGreeting("en");
  await panel.getByText("Saved model sample · interval boundaries ±1 h", { exact: true }).waitFor();
  await panel.getByText("Athena · IM-2 · Sun and Earth visible").waitFor();
  await panel.getByText("Odysseus · IM-1 · Outside the joint visibility window").waitFor();
  const questions = panel.locator("details[name] > summary");
  assert.equal(await questions.count(), 4);
  for (const [index, expected] of ["choose a week", "no live feed", "no signal-strength estimate"].entries()) {
    await questions.nth(index).click();
    const answer = panel.locator("details[open] p");
    assert.equal(await answer.count(), 1);
    assert.ok((await answer.textContent()).includes(expected));
  }
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.ok(await launcher.evaluate(button => button === document.activeElement));
  const saved = page.locator("#observed-week .week-selection select");
  const week1 = "2026-11-14 → 2026-11-20 UTC";
  const week2 = "2026-11-21 → 2026-11-27 UTC";
  async function checkSavedAnswer(button, question, selection, expected) {
    await saved.selectOption(selection);
    await button.click();
    const summary = panel.getByText(question, { exact: true });
    if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
    const list = panel.locator("details[open] li");
    assert.deepEqual(await list.allInnerTexts(), expected);
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
  }
  const english = "How long are the Sun and Earth both visible in my saved comparison?";
  const vietnamese = "Trong kết quả đã chọn, cả Mặt Trời và Trái Đất cùng xuất hiện trong bao lâu?";
  await checkSavedAnswer(launcher, english, "2026-11-14T00:00:00Z", [
    "Odysseus · IM-1 · 33 h\n" + week1, "Athena · IM-2 · 139 h\n" + week1,
  ]);
  await checkSavedAnswer(launcher, english, "im2_athena", [
    "Athena · IM-2 · 139 h\n" + week1, "Athena · IM-2 · 168 h\n" + week2,
  ]);
  // Opening the guide from the selected saved result starts with its rows.
  await launcher.click();
  await panel.getByText("Ask the astronaut", { exact: true }).click();
  const source = panel.getByRole("combobox", { name: "Use data from" });
  assert.equal(await source.inputValue(), "saved");
  const request = page.waitForRequest(req => new URL(req.url()).pathname === "/guide/chat");
  const responseGate = Promise.withResolvers();
  await page.route("**/guide/chat", async route => {
    await responseGate.promise;
    await route.fulfill({ json: { answer: "OK", action: null } });
  });
  await panel.getByRole("textbox").fill("Which result am I viewing?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  const { context } = (await request).postDataJSON();
  const face = panel.locator("header [aria-hidden=true]");
  await panel.getByRole("status").getByText("The astronaut is thinking…").waitFor();
  assert.ok((await face.evaluate(el => getComputedStyle(el, "::after").backgroundImage)).includes("guide-think-strip.webp"));
  responseGate.resolve();
  await panel.getByText("OK", { exact: false }).waitFor();
  assert.equal(await face.evaluate(el => getComputedStyle(el, "::after").content), "none");
  assert.equal(context.kind, "saved");
  assert.deepEqual(context.rows.map(row => [row.site, row.bothHours]), [["Athena · IM-2", 139], ["Athena · IM-2", 168]]);
  await source.selectOption("workspace");
  await page.keyboard.press("Escape");
  await saved.selectOption("im1_odysseus");
  await launcher.click();
  await panel.getByText("Ask the astronaut", { exact: true }).click();
  assert.equal(await source.inputValue(), "workspace");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
  const viLauncher = page.getByRole("button", { name: "Hướng dẫn của phi hành gia", exact: true });
  await checkSavedAnswer(viLauncher, vietnamese, "2026-11-21T00:00:00Z", [
    "Odysseus · IM-1 · 168 h\n" + week2, "Athena · IM-2 · 168 h\n" + week2,
  ]);
  await checkSavedAnswer(viLauncher, vietnamese, "im1_odysseus", [
    "Odysseus · IM-1 · 33 h\n" + week1, "Odysseus · IM-1 · 168 h\n" + week2,
  ]);
  await viLauncher.click();
  await panel.getByText("Odysseus · IM-1 · Ngoài khoảng nhìn thấy đồng thời").waitFor();
  await checkGreeting("vi");
  await page.keyboard.press("Escape");
  await page.clock.setFixedTime(new Date("2026-11-28T00:00:00Z"));
  await viLauncher.click();
  await panel.getByText("Hỏi phi hành gia", { exact: true }).waitFor();
  await checkGreeting("vi");
  assert.equal(await panel.locator("time").count(), 0);
  await questions.first().click();
  const box = await panel.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 568);
  await page.keyboard.press("Escape");
  assert.deepEqual(await viLauncher.evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation).length), 0);
  await viLauncher.click();
  await panel.getByRole("link", { name: "Đến phần so sánh kết quả đã lưu" }).click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).hash, "#observed-week");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "observed-week");
  await viLauncher.click();
  await panel.waitFor({ state: "visible" });
  await panel.getByRole("button", { name: "Đóng hướng dẫn của phi hành gia" }).click();
  await panel.waitFor({ state: "hidden" });
  await page.emulateMedia({ media: "print" });
  assert.equal(await viLauncher.isVisible(), false);
  const fallback = await browser.newPage({ reducedMotion: "no-preference" });
  await fallback.addInitScript(() => localStorage.setItem("moon-plan-b-language", "vi"));
  await fallback.route("**/images/guide-visor-wave.webp", route => route.fulfill({ status: 404 }));
  await fallback.goto(origin);
  const help = fallback.getByRole("button", { name: "Hướng dẫn của phi hành gia", exact: true });
  await fallback.waitForFunction(() => Array.from(document.images).some(img =>
    img.currentSrc.endsWith("guide-visor-rest.webp") && img.naturalWidth === 120));
  await fallback.route("**/images/guide-visor-rest.webp", route => route.fulfill({ status: 404 }));
  await fallback.reload();
  await help.getByText("Trợ giúp", { exact: true }).waitFor();
  await help.press("Enter");
  await fallback.locator("aside:popover-open").waitFor();
  await fallback.close();
  console.log("Passed EN/VI question and answer flows, keyboard dismissal, saved-result link, 320px layout, reduced motion and print.");
} finally {
  await browser.close();
}
