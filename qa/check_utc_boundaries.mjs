import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [origin] = process.argv.slice(2);
if (!origin) throw Error("Pass the URL of a running frontend.");
const normal = await readFile(new URL("./fixtures/normal.json", import.meta.url), "utf8");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  chromiumSandbox: true, ignoreDefaultArgs: ["--enable-unsafe-swiftshader"] });

const cases = [
  ["leap-day-start", "Asia/Ho_Chi_Minh", "2024-02-28T22:00:00Z",
    ["28 Feb 2024, 23:00", "29 Feb 2024, 00:00"], [6, 7]],
  ["leap-day-end", "Asia/Ho_Chi_Minh", "2024-02-29T22:00:00Z",
    ["29 Feb 2024, 23:00", "01 Mar 2024, 00:00"], [6, 7]],
  ["hanoi-midnight", "Asia/Ho_Chi_Minh", "2024-02-29T15:00:00Z",
    ["29 Feb 2024, 16:00", "29 Feb 2024, 17:00"], [23, 0]],
  ["spring-clock-change", "America/New_York", "2024-03-10T05:00:00Z",
    ["10 Mar 2024, 06:00", "10 Mar 2024, 07:00"], [1, 3]],
  ["repeated-local-hour", "America/New_York", "2024-11-03T04:00:00Z",
    ["03 Nov 2024, 05:00", "03 Nov 2024, 06:00"], [1, 1]],
];
try {
  for (const [id, timezoneId, start, labels, localHours] of cases) {
    // Shift only the UTC fields of the synthetic fixture, including its supplied interval bounds.
    const delta = Date.parse(start) - Date.parse("2026-11-14T00:00:00Z");
    const data = JSON.parse(normal, (key, value) =>
      ["utc", "startUtc", "endUtc"].includes(key) ? new Date(Date.parse(value) + delta).toISOString() : value);
    data.datasetId = "qa-" + id;
    const page = await browser.newPage({ timezoneId, locale: "en-GB", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Import data", disabled: false }).waitFor();
    const file = page.getByLabel("Import JSON dataset");
    const upload = value => file.setInputFiles({ name: "boundary.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)) });
    await upload(data);
    await page.locator("#sources").getByText(data.datasetId, { exact: true }).waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Compare sites", exact: true }).click();
    assert.equal(await page.getByLabel(/^Primary site/).inputValue(), "ridge-1");
    assert.equal(await page.getByLabel(/^Alternative site/).inputValue(), "basin-1");
    await page.getByText("Inspect exact samples", { exact: true }).click();
    const times = data.scenarios[0].samples.map(sample => sample.utc);
    for (const role of ["Primary", "Alternative"]) {
      const rows = page.getByRole("table", { name: new RegExp("^" + role + " ·") }).locator("tbody th");
      assert.deepEqual(await rows.allTextContents(), times);
    }
    const slider = page.getByRole("slider", { name: "Timeline sample" });
    await slider.press("Home");
    for (const [key, index] of [["ArrowRight", 1], ["ArrowRight", 2], ["ArrowLeft", 1]]) {
      await slider.press(key);
      const stamp = times[index];
      const expected = labels[index - 1] + " UTC";
      assert.equal(await page.locator(".sample-time").innerText(), "Primary: " + expected + " · Alternative: " + expected);
      assert.ok((await slider.getAttribute("aria-valuetext")).endsWith(". Primary " + expected + ". Alternative " + expected));
      assert.equal(await page.locator("#local-sky time").getAttribute("datetime"), stamp);
      assert.equal(await page.evaluate(value => new Date(value).getHours(), stamp), localHours[index - 1]);
    }
    const boundary = Date.parse(times[2]);
    const selected = await page.locator(".sample-time").innerText();
    const accessible = await slider.getAttribute("aria-valuetext");
    await page.clock.install({ time: new Date(boundary - 60000) });
    await page.clock.pauseAt(new Date(boundary - 1000));
    assert.equal(await page.evaluate(() => new Date().getHours()), localHours[0]);
    await page.clock.runFor(2000);
    assert.equal(await page.evaluate(() => Date.now()), boundary + 1000);
    assert.equal(await page.evaluate(() => new Date().getHours()), localHours[1]);
    assert.equal(await page.locator(".sample-time").innerText(), selected);
    assert.equal(await slider.getAttribute("aria-valuetext"), accessible);
    assert.equal(await page.locator("#local-sky time").getAttribute("datetime"), times[1]);
    if (id === "leap-day-start") {
      for (const field of ["Sample timestamp", "Scenario start"]) {
        const invalid = structuredClone(data);
        invalid.datasetId = "invalid-calendar";
        if (field === "Sample timestamp") invalid.scenarios[0].samples[1].utc = "2023-02-29T00:00:00Z";
        else invalid.scenarios[0].startUtc = "2016-12-31T23:59:60Z";
        await upload(invalid);
        await page.getByRole("alert").filter({ hasText: field + " is not a real calendar instant" }).waitFor();
        assert.equal(await page.locator("#local-sky time").getAttribute("datetime"), times[1]);
        await page.locator("#sources").getByText(data.datasetId, { exact: true }).waitFor({ state: "attached" });
      }
    }
    assert.deepEqual(errors, []);
    console.log(id, labels.join(" → "), timezoneId, localHours.join(" → "));
    await page.close();
  }
  console.log("Chromium", browser.version(), new Date().toISOString());
} finally { await browser.close(); }
