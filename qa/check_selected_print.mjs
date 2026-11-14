import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.argv[2] || "http://127.0.0.1:3000";
const run = "B_spice_pgda_bruteforce_2026_2030";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });
const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
const requests = [];
context.on("request", request => {
  if (new URL(request.url()).pathname.startsWith("/api/v1/")) requests.push(request.url());
});
const page = await context.newPage();
const url = (path, params) => new URL(path + "?" + new URLSearchParams(params), origin).href;

async function checkPrint(button) {
  const snapshot = () => page.evaluate(() => ({
    url: location.href,
    details: Array.from(document.querySelectorAll("details"), e => e.open),
    selection: Array.from(document.querySelectorAll("select"), e => e.value),
  }));
  const before = await snapshot();
  const count = requests.length;
  if (button) {
    // Let Chromium's PDF invocation generate the real beforeprint/afterprint sequence.
    await page.evaluate(() => { window.print = () => {}; });
    await button.click();
  }
  const pdf = await page.pdf({ format: "A4" });
  const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: pdf, encoding: "utf8" });
  assert.deepEqual(await snapshot(), before);
  assert.equal(requests.length, count, "Printing must not issue additional model requests");
  return text;
}

try {
  await page.goto(url("/compare", { run_id: run, from: "2026-11-14T00:00:00Z", to: "2026-11-15T00:00:00Z", resolutionSeconds: "3600" }));
  const pair = page.locator("#terrain-pair");
  await pair.locator("summary").click();
  await pair.locator('[name="pairFirstSite"]').selectOption("a3_haworth");
  await pair.locator('[name="pairSecondSite"]').selectOption("apollo11");
  await pair.getByRole("button", { name: "Compare this pair" }).click();
  const ranked = page.getByRole("region", { name: "Pair comparison results" });
  await ranked.waitFor();
  const button = page.getByRole("button", { name: "Print ranked pair" });
  for (const printButton of [button, undefined]) {
    const text = await checkPrint(printButton);
    for (const expected of ["Pair comparison results", "Apollo 11", "Haworth", "Rank 1 of 2", "Rank 2 of 2", run, "SHA-256"]) assert.ok(text.includes(expected), expected);
    assert.doesNotMatch(text, /Odysseus|Athena/);
  }

  await page.goto(url("/compare-dates", { run_id: run, site_id: "im2_athena", from: "2026-12-01T00:00:00Z", to: "2026-12-04T00:00:00Z", from2: "2026-12-18T00:00:00Z", to2: "2026-12-21T00:00:00Z" }));
  await page.getByRole("link", { name: "Open date comparison in a new tab" }).waitFor();
  const panel = page.locator("#terrain-dates > details");
  await panel.locator(":scope > summary").click();
  assert.equal(await panel.getAttribute("open"), null);
  const compared = await checkPrint();
  for (const phrase of ["First window", "Second window", "Athena", run, "SHA-256", "Longest simultaneous Sun + Earth interval", "2026-12-01", "2026-12-18"]) assert.ok(compared.includes(phrase), phrase);

  await page.goto(url("/plan", { mode: "dates", site: "im2_athena", from: "2026-11-15", to: "2026-11-16", missionHours: "3" }));
  const field = name => page.locator('[name="' + name + '"]');
  await field("earliest").fill("2026-11-15T03:00");
  await field("latest").fill("2026-11-15T06:00");
  await field("objective").selectOption("earliest");
  await field("minBothPct").fill("100");
  await field("sunAtLanding").check();
  await field("earthAtLanding").check();
  await field("separationHours").fill("1");
  await field("maxResults").fill("2");
  await page.getByRole("button", { name: "Search landing dates" }).click();
  const results = page.getByRole("region", { name: "Landing search results" });
  await results.waitFor();
  const rejected = results.locator("details");
  assert.equal(await rejected.getAttribute("open"), null);
  const landing = await checkPrint();
  for (const phrase of ["Athena", run, "2 of 4", "Why landing times were rejected", "One landing time", "2026-11-15", "100%"]) assert.ok(landing.includes(phrase), phrase);
  console.log("Ranked-pair PDF, collapsed date comparison and landing-search rejections passed; print preserved selection and disclosures.");
} finally {
  await browser.close();
}
