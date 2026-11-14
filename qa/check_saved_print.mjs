import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Run against the mock production build with Playwright Chromium and Poppler.
const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running Moon Plan B frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true,
  ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage();
  const saved = page.locator("#observed-week");
  const selector = saved.getByRole("combobox");
  async function printText() {
    const pdf = await page.pdf({ format: "A4" });
    return execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" });
  }
  function checkAthena(text) {
    for (const expected of ["139 h", "168 h", "Athena", "B_spice_pgda_bruteforce_2026_2030", "953a39c"]) {
      assert.ok(text.includes(expected), expected);
    }
    assert.doesNotMatch(text, /Demo ridge A/);
  }
  await page.goto(origin);
  await page.getByRole("button", { name: "Print report", exact: true }).waitFor();
  await selector.selectOption("im2_athena");
  await saved.getByText("139 h", { exact: true }).waitFor();
  checkAthena(await printText());
  assert.equal(await saved.locator("details[open]").count(), 0);

  // Keep the explicit target until the browser finishes printing, even if print() returns first.
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole("button", { name: "Print report", exact: true }).click();
  const workspace = await printText();
  assert.match(workspace, /Demo ridge A/);
  assert.doesNotMatch(workspace, /B_spice_pgda_bruteforce/);
  checkAthena(await printText());

  await page.goBack();
  assert.match(await printText(), /Demo ridge A/);
  await page.goto(new URL("?saved=im2_athena", origin).href);
  await saved.getByText("139 h", { exact: true }).waitFor();
  checkAthena(await printText());
  console.log("Saved selection, workspace override, browser history and direct URL printed correctly.");
} finally {
  await browser.close();
}
