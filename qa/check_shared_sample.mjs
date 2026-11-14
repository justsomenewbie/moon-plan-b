import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running frontend.");
const filename = fileURLToPath(new URL("./evidence/odysseus-athena-hour-gap/gap.json", import.meta.url));
const dataset = JSON.parse(await readFile(filename, "utf8"));
const [odysseus, athena] = dataset.scenarios;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
const errors = [];
async function newContext() {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh", reducedMotion: "reduce" });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  // This fixture is supplied by its owner, independently of the initial terrain endpoint.
  await context.route("**/api/v1/dataset?*", route => route.fulfill({ status: 404, json: { detail: "Supply the local QA release." } }));
  return context;
}
async function supplyFile(page) {
  await page.getByRole("button", { name: /^(Import data|Nhập dữ liệu)$/, disabled: false }).waitFor();
  await page.locator("input[type=file]").setInputFiles(filename);
  await page.locator("#sources").getByText(dataset.datasetId, { exact: true }).waitFor({ state: "attached" });
}
const slider = page => page.getByRole("slider", { name: /^(Timeline sample|Mẫu trên dòng thời gian)$/ });
const utc = hour => "2026-01-07T0" + hour + ":00:00Z";
async function checkSelection(page, locale, hour) {
  const vi = locale === "vi";
  assert.equal(await page.locator("html").getAttribute("lang"), locale);
  assert.equal(await page.getByLabel(vi ? /^Vị trí chính/ : /^Primary site/).inputValue(), athena.id);
  assert.equal(await page.getByLabel(vi ? /^Vị trí đối chiếu/ : /^Alternative site/).inputValue(), odysseus.id);
  const time = vi ? "0" + hour + ":00 07 thg 1, 2026 UTC" : "07 Jan 2026, 0" + hour + ":00 UTC";
  const a = vi ? "Chính" : "Primary", b = vi ? "Đối chiếu" : "Alternative";
  assert.equal(await page.locator(".sample-time").innerText(), a + ": " + time + " · " + b + ": " + time);
  const accessible = await slider(page).getAttribute("aria-valuetext");
  assert.ok(accessible.endsWith(". " + a + " " + time + ". " + b + " " + time));
  assert.equal(await page.locator("#local-sky time").getAttribute("datetime"), utc(hour));

  const sources = page.locator("#sources");
  await sources.getByText(dataset.datasetId, { exact: true }).waitFor({ state: "attached" });
  assert.ok((await sources.innerText()).includes(dataset.schemaVersion));
  for (const source of dataset.sources) {
    const entry = sources.locator("#source-" + source.id);
    assert.equal(await entry.locator("a").getAttribute("href"), source.url);
    assert.ok((await entry.innerText()).includes(source.id + " · " + source.version));
    if (source.rawSha256) assert.equal(await entry.locator(".hash").innerText(), "SHA-256 " + source.rawSha256);
  }
  for (const [index, scenario] of [athena, odysseus].entries()) {
    const site = dataset.sites.find(site => site.id === scenario.siteId);
    const coords = sources.locator(".site-provenance").filter({ has: page.getByRole("heading", { name: site.name, exact: true }) });
    const values = await coords.locator("dd").allTextContents();
    assert.deepEqual(values.slice(0, 3), [site.location.latitudeDeg + "°", site.location.longitudeEastDeg + "°", site.location.elevationKm + " km"]);
    const evidence = sources.getByRole("link", { name: new RegExp("^" + (index ? b : a) + " ") });
    assert.equal(await evidence.getAttribute("href"), scenario.evidenceUrl);
    assert.ok((await evidence.locator("..").innerText()).includes(scenario.sourceIds.join(", ")));
    const table = page.locator(".sample-table table").nth(index);
    const sample = scenario.samples.find(sample => sample.utc === utc(hour));
    const row = table.locator("tr").filter({ hasText: sample.utc });
    assert.deepEqual(await row.locator("td").allTextContents(),
      [sample.sun.elevationDeg, sample.sun.azimuthDeg, sample.earth.elevationDeg, sample.earth.azimuthDeg].map(value => value + "°"));
  }
}
async function share(page, hour) {
  await page.locator("button.share-comparison").click();
  const url = new URL(await page.locator(".share-field input").inputValue());
  const sample = url.searchParams.get("sample");
  assert.match(sample, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/);
  assert.equal(Date.parse(sample), Date.parse(utc(hour)));
  assert.equal(url.searchParams.get("v"), dataset.datasetId);
  assert.equal(url.searchParams.get("a"), athena.id);
  assert.equal(url.searchParams.get("b"), odysseus.id);
  return url;
}
try {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(new URL("/compare", origin).href);
  await supplyFile(page);
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  await page.getByLabel(/^Primary site/).selectOption(athena.id);
  await slider(page).press("Home");
  await slider(page).press("ArrowRight");
  await slider(page).press("ArrowRight");
  await checkSelection(page, "en", 3);
  await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
  await checkSelection(page, "vi", 3);
  const first = await share(page, 3);
  const same = await context.newPage();
  await same.goto(first.href);
  await supplyFile(same);
  await checkSelection(same, "vi", 3);

  await slider(page).press("ArrowLeft");
  await checkSelection(page, "vi", 1);
  const second = await share(page, 1);
  assert.notEqual(second.href, first.href);
  const fresh = await newContext();
  const reopened = await fresh.newPage();
  await reopened.goto(second.href);
  await supplyFile(reopened);
  await checkSelection(reopened, "en", 1);

  second.searchParams.set("sample", utc(2));
  await reopened.goto(second.href);
  await supplyFile(reopened);
  const alert = reopened.locator("#data-error[role=alert]");
  await alert.waitFor();
  assert.match(await alert.innerText(), /sample|timestamp|instant/i);
  assert.equal(await reopened.locator("#workspace.workspace, .sample-time, #local-sky time").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Athena-primary EN/VI shared samples 03:00 and 01:00 UTC restored; unavailable 02:00 rejected.", browser.version());
} finally { await browser.close(); }
