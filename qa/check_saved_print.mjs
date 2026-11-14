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
  const apiRequests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  const saved = page.locator("#observed-week");
  const selector = saved.getByRole("combobox", { name: "Compare saved results" });
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
  await page.goto(new URL("/compare", origin).href);
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
  const globe = page.locator("#lunar-reference");
  await saved.getByRole("link", { name: "View lunar globe" }).click();
  checkAthena(await printText());
  await globe.getByRole("link", { name: "Source and interval checks" }).click();
  const source = saved.locator("#saved-model-source");
  await source.waitFor({ state: "visible" });
  checkAthena(await printText());

  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole("button", { name: "Print report", exact: true }).click();
  assert.match(await printText(), /Demo ridge A/);
  checkAthena(await printText());

  await page.goto(new URL("?saved=im2_athena#saved-model-source", origin).href);
  await source.waitFor({ state: "visible" });
  checkAthena(await printText());

  const disclosure = saved.locator("details:has(#saved-model-source)");
  for (const locale of ["en", "vi"]) {
    await page.getByRole("combobox", { name: /^(Language|Ngôn ngữ)$/ }).selectOption(locale);
    const requestsBeforeReload = apiRequests.length;
    await page.reload();
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation")[0].type), "reload");
    await page.locator(`html[lang="${locale}"]`).waitFor();
    await page.getByRole("button", { name: locale === "en" ? "Print report" : "In báo cáo", exact: true }).waitFor();
    await source.waitFor({ state: "visible" });
    assert.ok(await disclosure.evaluate(element => element.open));
    await disclosure.locator("summary").click();
    assert.ok(!await source.isVisible());
    await saved.locator('a[href="#lunar-reference"]').click();
    assert.ok(!await source.isVisible());
    await page.goBack();
    await source.waitFor({ state: "visible" });
    assert.ok(await disclosure.evaluate(element => element.open));
    // A real reload fetches the mock workspace dataset once. Opening the source and
    // traversing same-document history must not request another result.
    const apiSinceReload = apiRequests.slice(requestsBeforeReload);
    assert.deepEqual(apiSinceReload.map(url => new URL(url).pathname), ["/api/v1/dataset"]);
  }
  await page.getByRole("combobox", { name: "Ngôn ngữ" }).selectOption("en");

  await page.goto(new URL("/compare#lunar-reference", origin).href);
  await page.getByRole("button", { name: "Print report", exact: true }).waitFor();
  assert.match(await printText(), /Demo ridge A/);
  await page.goto(new URL("?saved=im2_athena#workspace", origin).href);
  await page.getByRole("button", { name: "Print report", exact: true }).waitFor();
  assert.match(await printText(), /Demo ridge A/);
  console.log("Saved selection, globe and source links, explicit workspace print, history and direct URLs printed correctly.");
} finally {
  await browser.close();
}
