import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running frontend.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ timezoneId: "UTC", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();

  async function importFixture(name) {
    const file = fileURLToPath(new URL("./fixtures/" + name + ".json", import.meta.url));
    await page.getByLabel("Import JSON dataset").setInputFiles(file);
    await page.locator("#sources").getByText("qa-" + name + "-v1", { exact: true }).waitFor({ state: "attached" });
  }
  const mask = page.locator("#horizon-clearance-input");
  const limit = page.locator(".battery-picker select");
  const rows = page.locator(".mission-scenario-row");
  const hud = page.locator(".hud-readouts dd");
  const key = page.locator(".sky-scenario-key");
  const slider = page.getByRole("slider", { name: "Timeline sample" });
  const line = page.locator(".timeline-svg .clearance-line");
  const ring = page.locator(".skyplot .clearance-ring");
  async function stateMatches(state) {
    assert.equal(await hud.first().innerText(), await page.locator(".state-legend ." + state).innerText());
  }

  async function checkShadow(bearing, elevation) {
    const readout = await hud.last().innerText();
    assert.match(readout, new RegExp("^Az " + bearing + "°"));
    const factor = readout.match(/([0-9.]+)×/);
    assert.ok(factor, readout);
    const expected = 1 / Math.tan(elevation * Math.PI / 180);
    assert.ok(Math.abs(Number(factor[1]) - expected) < 0.05, readout);
  }

  await importFixture("normal");
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  await slider.press("Home");
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), /A · Synthetic south-pole ridge/);
  assert.match(await rows.nth(1).innerText(), /B · Synthetic south-pole basin/);
  const producerHours = page.locator(".comparison tbody td");
  const baseline = await producerHours.allTextContents();
  assert.equal(baseline.length, 6);
  assert.equal(await ring.count(), 0);
  assert.equal(await line.count(), 0);
  // The synthetic ridge has a 0.2-degree Sun at azimuth 100. On flat ground, cot(0.2°) = 286.5.
  assert.match(await hud.nth(1).innerText(), /100°.*0\.2°/);
  assert.match(await hud.nth(2).innerText(), /180°.*1°/);
  await checkShadow(280, 0.2);
  await stateMatches("golden");
  await mask.press("ArrowRight");
  assert.equal(await mask.inputValue(), "0.5");
  assert.equal(await mask.getAttribute("aria-valuetext"), "0.5°");
  assert.equal(Number(await line.getAttribute("y1")), (90 - 0.5) / 180 * 240);
  assert.equal(Number(await ring.getAttribute("r")), 82 * (90 - 0.5) / 90);
  await stateMatches("comms-only");
  await key.locator('button[data-site="B"]').click();
  assert.equal(await key.locator('button[data-site="B"]').getAttribute("aria-pressed"), "true");
  assert.match(await hud.nth(1).innerText(), /200°.*1°/);
  await checkShadow(20, 1);
  await stateMatches("golden");
  await page.locator(".preset-pills button").filter({ hasText: /^2°/ }).click();
  assert.equal(await mask.inputValue(), "2");
  await stateMatches("blackout");
  await limit.selectOption("6");
  for (const row of await rows.all()) assert.match(await row.locator(".mission-metrics-row").innerText(), /4 h\s*\/\s*6 h/);
  assert.deepEqual(await producerHours.allTextContents(), baseline);

  const labelEN = await page.locator('label[for="horizon-clearance-input"]').innerText();
  const limitEN = await page.locator(".battery-picker span").innerText();
  const ribbonEN = await rows.first().getByRole("img").getAttribute("aria-label");
  assert.ok(ribbonEN);
  await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
  assert.notEqual(await page.locator('label[for="horizon-clearance-input"]').innerText(), labelEN);
  assert.notEqual(await page.locator(".battery-picker span").innerText(), limitEN);
  assert.notEqual(await rows.first().getByRole("img").getAttribute("aria-label"), ribbonEN);
  assert.equal(await limit.inputValue(), "6");
  assert.equal(await mask.inputValue(), "2");
  await stateMatches("blackout");
  await page.getByRole("combobox", { name: "Ngôn ngữ" }).selectOption("en");

  await importFixture("partial");
  await page.getByRole("button", { name: "Compare dates", exact: true }).click();
  await slider.press("Home");
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  assert.match(await page.locator(".sample-time").innerText(), /02:00 UTC/);
  assert.deepEqual((await hud.allInnerTexts()).slice(0, 4), ["Unavailable", "Unavailable", "Az 182° · El 1°", "Unavailable"]);
  assert.equal(await hud.last().innerText(), "Unavailable");
  assert.equal(await page.locator(".hud-sun-node, .hud-solar-wing, .hud-shadow-ray").count(), 0);
  assert.equal(await page.locator(".hud-earth-node").count(), 1);
  assert.equal(await rows.locator(".mission-metrics-row").count(), 0);
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.locator(".mission-metrics-row").count(), 0);
  for (const row of await rows.all()) {
    const covered = await row.locator(".ribbon-seg").evaluateAll(segments =>
      segments.map(segment => [segment.style.left, segment.style.width]));
    assert.deepEqual(covered, [["0%", "25%"], ["75%", "25%"]]);
  }

  await importFixture("missing");
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  assert.deepEqual(await rows.locator(".ribbon-empty").allInnerTexts(), ["Unavailable", "Unavailable"]);
  assert.equal(await rows.locator(".mission-metrics-row, .ribbon-seg").count(), 0);
  assert.ok(await slider.isDisabled());
  assert.deepEqual(await hud.allInnerTexts(), Array(5).fill("Unavailable"));
  assert.equal(await page.locator(".hud-solar-wing, .hud-dish-arc, .hud-dish-boom, .hud-sun-node, .hud-earth-node, .hud-shadow-ray").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Normal, partial and missing fixtures passed in Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
