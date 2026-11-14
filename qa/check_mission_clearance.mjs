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
  await page.goto(new URL("/compare", origin).href);
  await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();

  async function importFixture(name) {
    const file = fileURLToPath(new URL("./fixtures/" + name + ".json", import.meta.url));
    await page.getByRole("button", { name: "Import data", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import a comparison dataset" });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog.getByLabel("Import JSON dataset").click()]);
    await chooser.setFiles(file);
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

  // Read the actual band edge and displayed ray from the SVG. Its viewBox uses the same units on both axes.
  async function checkSideAngle(body, expectedElevation, expectedMask) {
    const side = page.locator(".lander-side-svg");
    const coordinates = await side.locator(".hud-clearance-band").getAttribute("d");
    const [x, y, , , edgeX, edgeY] = coordinates.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const ray = side.locator(".hud-" + body + "-ray");
    const endX = Number(await ray.getAttribute("x2")), endY = Number(await ray.getAttribute("y2"));
    const degrees = (endX, endY) => Math.atan2(y - endY, endX - x) * 180 / Math.PI;
    assert.ok(Math.abs(degrees(edgeX, edgeY) - expectedMask) < 0.01, "Drawn side-view threshold " + expectedMask);
    assert.ok(Math.abs(degrees(endX, endY) - expectedElevation) < 0.01, "Drawn side-view " + body + " " + expectedElevation);
    assert.equal(Boolean(await ray.getAttribute("stroke-dasharray")), expectedElevation <= expectedMask);
  }

  async function checkRibbon(row, expectedStates, spans) {
    const segments = row.locator(".ribbon-seg");
    const drawn = await segments.evaluateAll(nodes => nodes.map(n => [n.classList[1], n.style.left, n.style.width]));
    assert.deepEqual(drawn, expectedStates.map((state, i) => [state, ...spans[i]]));
    const unavailable = segments.and(row.locator(".unavailable"));
    const label = await unavailable.getAttribute("title");
    assert.match(label, expectedStates.length === 1 ? /Unavailable: .*T00:00:00.* → .*T04:00:00.* \(4 h\)/ :
      /Unavailable: .*T01:00:00.* → .*T03:00:00.* \(2 h\)/);
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
  assert.equal(await mask.inputValue(), "0.1");
  assert.equal(await mask.getAttribute("aria-valuetext"), "0.1° simulated uniform clearance");
  await checkSideAngle("sun", 0.2, 0.1);
  await mask.press("ArrowRight");
  await checkSideAngle("sun", 0.2, 0.2);
  await stateMatches("comms-only");
  for (let i = 0; i < 3; i++) await mask.press("ArrowRight");
  assert.equal(await mask.inputValue(), "0.5");
  assert.equal(await mask.getAttribute("aria-valuetext"), "0.5° simulated uniform clearance");
  assert.equal(Number(await line.getAttribute("y1")), (90 - 0.5) / 180 * 240);
  assert.equal(Number(await ring.getAttribute("r")), 82 * (90 - 0.5) / 90);
  await checkSideAngle("sun", 0.2, 0.5);
  await checkSideAngle("earth", 1, 0.5);
  await stateMatches("comms-only");
  await key.locator('button[data-site="B"]').click();
  assert.equal(await key.locator('button[data-site="B"]').getAttribute("aria-pressed"), "true");
  assert.match(await hud.nth(1).innerText(), /200°.*1°/);
  await checkShadow(20, 1);
  await stateMatches("golden");
  await page.locator(".preset-pills button").filter({ hasText: /^2°/ }).click();
  assert.equal(await mask.inputValue(), "2");
  await stateMatches("blackout");
  await limit.selectOption("100");
  for (const row of await rows.all()) {
    assert.match(await row.locator(".mission-metrics-row").innerText(), /4 h\s*\/\s*100 h/);
    assert.match(await row.locator(".battery-badge").innerText(), /Unresolved at window boundary/);
    assert.match(await row.getByRole("img").getAttribute("aria-label"), /Neither above 4 h · 100%/);
  }
  assert.deepEqual(await producerHours.allTextContents(), baseline);

  const labelEN = await page.locator('label[for="horizon-clearance-input"]').innerText();
  const limitEN = await page.locator(".battery-picker span").innerText();
  const caption = page.locator(".lander-hud-diagrams p");
  assert.match(await caption.innerText(), /not local terrain/);
  await page.emulateMedia({ forcedColors: "active" });
  const swatches = await page.locator(".state-legend .state-dot").evaluateAll(labels => labels.map(label => {
    const style = getComputedStyle(label, "::before");
    return [style.backgroundColor, style.backgroundImage].join(" ");
  }));
  assert.equal(new Set(swatches).size, 5, "All five states remain distinguishable in forced colors");
  await page.emulateMedia({ forcedColors: "none" });
  const ribbonEN = await rows.first().getByRole("img").getAttribute("aria-label");
  assert.ok(ribbonEN);
  await page.getByRole("combobox", { name: "Language" }).selectOption("vi");
  assert.notEqual(await page.locator('label[for="horizon-clearance-input"]').innerText(), labelEN);
  assert.notEqual(await page.locator(".battery-picker span").innerText(), limitEN);
  assert.notEqual(await rows.first().getByRole("img").getAttribute("aria-label"), ribbonEN);
  assert.equal(await limit.inputValue(), "100");
  assert.equal(await mask.inputValue(), "2");
  await page.setViewportSize({ width: 320, height: 720 });
  assert.match(await caption.innerText(), /không phải địa hình địa phương/);
  assert.ok(await caption.evaluate(p => p.scrollWidth <= p.clientWidth && p.scrollHeight <= p.clientHeight));
  await mask.press("ArrowLeft");
  assert.equal(await mask.inputValue(), "1.9");
  assert.match(await mask.getAttribute("aria-valuetext"), /^Ngưỡng thông thoáng đồng đều mô phỏng 1[,.]9°$/);
  await checkSideAngle("earth", 1, 1.9);
  await mask.press("ArrowRight");
  assert.equal(await mask.inputValue(), "2");
  await stateMatches("blackout");
  await page.getByRole("combobox", { name: "Ngôn ngữ" }).selectOption("en");
  assert.equal(await mask.getAttribute("aria-valuetext"), "2.0° simulated uniform clearance");
  assert.equal(await rows.first().getByRole("img").getAttribute("aria-label"), ribbonEN);
  await mask.press("Home");

  await importFixture("partial");
  await page.getByRole("button", { name: "Compare dates", exact: true }).click();
  await slider.press("Home");
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  assert.match(await page.locator(".sample-time").innerText(), /02:00 UTC/);
  assert.deepEqual((await hud.allInnerTexts()).slice(0, 4), ["Unavailable", "Unavailable", "Az 182° · El 1°", "Unavailable"]);
  assert.equal(await hud.last().innerText(), "Unavailable");
  assert.equal(await page.locator(".hud-sun-node, .hud-solar-wing, .hud-shadow-ray").count(), 0);
  for (const view of [".lander-hud-svg", ".lander-side-svg"]) {
    assert.equal(await page.locator(view + " .hud-earth-node").count(), 1);
  }
  assert.equal(await rows.locator(".mission-metrics-row").count(), 0);
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.locator(".mission-metrics-row").count(), 0);
  const spans = [["0%", "25%"], ["25%", "50%"], ["75%", "25%"]];
  await checkRibbon(rows.nth(0), ["comms-only", "unavailable", "comms-only"], spans);
  await checkRibbon(rows.nth(1), ["golden", "unavailable", "golden"], spans);

  await importFixture("missing");
  await page.getByRole("button", { name: "Compare sites", exact: true }).click();
  assert.equal(await rows.count(), 2);
  for (const row of await rows.all()) await checkRibbon(row, ["unavailable"], [["0%", "100%"]]);
  assert.equal(await rows.locator(".mission-metrics-row").count(), 0);
  assert.ok(await slider.isDisabled());
  assert.deepEqual(await hud.allInnerTexts(), Array(5).fill("Unavailable"));
  assert.equal(await page.locator(".hud-solar-wing, .hud-dish-arc, .hud-dish-boom, .hud-sun-node, .hud-earth-node, .hud-shadow-ray").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Normal, partial and missing fixtures passed in Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
