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
  await page.goto(origin);
  const launcher = page.getByRole("button", { name: "Astronaut guide", exact: true });
  const panel = page.locator("aside[popover]");
  await launcher.focus();
  await page.keyboard.press("Enter");
  await panel.waitFor({ state: "visible" });
  await panel.getByText("2026-11-15 05:00:00 UTC").waitFor();
  await panel.getByText("Athena · IM-2 · Sun and Earth visible").waitFor();
  await panel.getByText("Odysseus · IM-1 · Outside the joint visibility window").waitFor();
  const questions = panel.locator("summary");
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
  await page.keyboard.press("Escape");
  await page.clock.setFixedTime(new Date("2026-11-28T00:00:00Z"));
  await viLauncher.click();
  await panel.getByText("Bạn muốn tìm hiểu điều gì?").waitFor();
  await questions.first().click();
  const box = await panel.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 320 && box.y >= 0 && box.y + box.height <= 568);
  assert.equal(await viLauncher.locator("span").evaluate(el => getComputedStyle(el).animationName), "none");
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
  console.log("Passed EN/VI question and answer flows, keyboard dismissal, saved-result link, 320px layout, reduced motion and print.");
} finally {
  await browser.close();
}
