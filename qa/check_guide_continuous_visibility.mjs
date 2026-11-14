import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const [origin, replayPath] = process.argv.slice(2);
if (!origin) throw Error("Pass a frontend URL in live mode and optionally a B2 /dataset JSON replay for all 23 sites, 2026-11-28 to 2026-12-12 UTC, including windows, metrics and criteria.");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const read = file => readFile(file, "utf8").then(JSON.parse);
const catalog = await read(new URL("../frontend/public/data/run-b2/catalog.json", import.meta.url));
const archive = await read(new URL("../frontend/public/data/run-b2/visibility.json", import.meta.url));
const importedFile = fileURLToPath(new URL("./evidence/b2-horizons-week/dataset.json", import.meta.url));
const legacyRun = "B_spice_pgda_bruteforce_2026_2030";
const b2 = catalog.run_id;
const first = "2026-11-28", last = "2026-12-12";
const midnight = date => date + "T00:00:00Z";
const b2WindowEnd = "2026-12-01T20:00:00Z";
const ids = catalog.sites.map(site => site.id);
const replay = replayPath ? await read(replayPath) : null;
if (replay) {
  assert.equal(replay.run.run_id, b2);
  assert.deepEqual(replay.sites.map(site => site.id), ids);
  assert.equal(replay.range.start, midnight(first));
  assert.equal(replay.range.end, midnight(last));
  assert.deepEqual(replay.include.slice().sort(), ["criteria", "metrics", "windows"]);
  // Malapert's 114 total hours come from two separate windows. Odysseus has 92 continuous hours.
  const malapert = replay.sites.find(site => site.id === "a3_malapert_massif");
  const odysseus = replay.sites.find(site => site.id === "im1_odysseus");
  assert.deepEqual(malapert.windows.both.map(window => window.duration_h), [76, 38]);
  assert.deepEqual(odysseus.windows.both.map(({ start, end, duration_h }) => [start, end, duration_h]),
    [[midnight(first), b2WindowEnd, 92]]);
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, chromiumSandbox: true });
try {
  for (const locale of ["en", "vi"]) {
    const en = locale === "en";
    const page = await browser.newPage({ serviceWorkers: "block", reducedMotion: "reduce" });
    await page.addInitScript(language => localStorage.setItem("moon-plan-b-language", language), locale);
    const api = [], unexpected = [], errors = [];
    let outage = false;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/guide/chat", route => { unexpected.push(route.request().url()); return route.abort(); });
    await page.route("**/api/**", route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      api.push(url);
      if (request.method() === "GET") {
        if (path === "/api/v1/runs/" + b2) return route.fulfill({ json: {
          run_id: b2, is_default: true, status: "ready", start_utc: archive.start, end_utc: archive.end,
          n_samples: archive.sampleCount, n_sites: ids.length, step_s: archive.stepSeconds, site_ids: ids,
        } });
        if (path === "/api/v1/sites" && url.searchParams.get("run_id") === b2) return route.fulfill({ json: catalog });
        if (path === "/api/v1/dataset" && url.searchParams.get("run_id") === b2) {
          if (!outage && replay) return route.fulfill({ json: replay });
          return route.fulfill({ status: 503, json: { status: 503, title: "Test outage", detail: "Test outage" } });
        }
      }
      unexpected.push(url.href);
      return route.abort();
    });
    const chat = page.getByRole("region", { name: en ? "Ask the astronaut" : "Hỏi phi hành gia" });
    async function openGuide() {
      await page.getByRole("button", { name: en ? "Astronaut guide" : "Hướng dẫn của phi hành gia", exact: true }).click();
      await chat.waitFor();
    }
    async function ask(from = first, to = last) {
      const question = en ? `Which site has the longest uninterrupted Sun and Earth visibility from ${from} to ${to}?`
        : `Từ ${from} đến ${to}, địa điểm nào có khoảng thời gian liên tục dài nhất cùng thấy Mặt Trời và Trái Đất?`;
      const turns = chat.getByRole("log").locator(":scope > div");
      const index = await turns.count();
      await chat.locator("textarea").fill(question);
      await chat.locator("button[type=submit]").click();
      const turn = turns.nth(index), answer = turn.locator("p").nth(1);
      await answer.waitFor();
      return { answer: await answer.innerText(), turn };
    }
    function expectWinner(answer, site, hours, start, end, from, to, scope) {
      for (const fact of [b2, scope, site, hours + " h", start, end, midnight(from), midnight(to)]) {
        assert.ok(answer.includes(fact), "Missing " + fact + " in " + answer);
      }
      assert.match(answer, en ? /uninterrupted|continuous/i : /liên tục/i);
    }
    async function expectLink(turn, key, value) {
      const url = new URL(await turn.getByRole("link").getAttribute("href"), origin);
      assert.equal(url.pathname, "/plan");
      assert.equal(url.searchParams.get("order"), "longest");
      assert.equal(url.searchParams.get(key), value);
      assert.equal(url.searchParams.get("from"), first);
      assert.equal(url.searchParams.get("to"), last);
    }
    await page.goto(new URL("/plan?source=saved-b2", origin).href);
    await openGuide();
    const saved = await ask();
    expectWinner(saved.answer, "Odysseus", 92, midnight(first), b2WindowEnd, first, last, "23/23");
    assert.doesNotMatch(saved.answer, /114 h|Malapert/);
    await expectLink(saved.turn, "source", "saved-b2");
    await saved.turn.getByRole("link").click();
    const planner = page.locator(".plan-results");
    await planner.waitFor();
    assert.equal(await page.locator('select[name="priority"]').inputValue(), "longest");
    assert.match(await planner.locator(".data-notice").innerText(), /92 h.*Odysseus/);
    assert.equal(api.length, 0, "Saved B2 must work without a producer request.");

    // The earlier run has totals, but its retained joint windows end precisely when this query starts.
    await page.goto(new URL("/plan?source=saved", origin).href);
    await openGuide();
    const legacy = await ask();
    assert.ok(legacy.answer.includes(legacyRun), legacy.answer);
    assert.match(legacy.answer, en ? /no joint visibility intervals/i : /không có các khoảng/i);
    assert.doesNotMatch(legacy.answer, /92 h|B2_spice/);
    await expectLink(legacy.turn, "source", "saved");
    assert.equal(api.length, 0);

    await page.goto(new URL("/plan?run_id=" + b2, origin).href);
    await page.locator(".plan-source code").getByText(b2, { exact: true }).waitFor();
    await openGuide();
    async function askLive() {
      const before = api.length;
      const result = await ask();
      assert.equal(api.length, before + 1, "One raw window request should answer the question.");
      const url = api[before];
      assert.equal(url.pathname, "/api/v1/dataset");
      assert.equal(url.searchParams.get("site_ids"), ids.join(","));
      assert.equal(url.searchParams.get("start"), midnight(first));
      assert.equal(url.searchParams.get("end"), midnight(last));
      assert.deepEqual(url.searchParams.get("include").split(",").sort(), ["criteria", "metrics", "windows"]);
      await expectLink(result.turn, "run_id", b2);
      return result.answer;
    }
    if (replay) {
      const live = await askLive();
      expectWinner(live, "Odysseus", 92, midnight(first), b2WindowEnd, first, last, "23/23");
      assert.doesNotMatch(live, /114 h|Malapert/);
    }
    outage = true;
    const unavailable = await askLive();
    assert.ok(unavailable.includes(b2), unavailable);
    assert.match(unavailable, en ? /could not verify/i : /chưa xác minh/i);
    assert.doesNotMatch(unavailable, /92 h|Odysseus/);

    // Import an actual team dataset without a live workspace lookup or a model call.
    await page.goto(new URL("/compare?run_id=" + b2 + "&site_id=im1_odysseus&from=" + midnight(first) +
      "&to=" + midnight(last) + "&resolutionSeconds=3600", origin).href);
    await page.locator("#data-error").getByText("Test outage", { exact: true }).waitFor();
    await page.getByRole("button", { name: en ? "Import data" : "Nhập dữ liệu", exact: true }).click();
    await page.locator("#import-dialog input[type=file]").setInputFiles(importedFile);
    await page.locator("#workspace.terrain-result").waitFor();
    await openGuide();
    await chat.locator("select").selectOption("workspace");
    const before = api.length;
    const imported = await ask("2026-11-14", "2026-11-21");
    expectWinner(imported.answer, "Athena", 139, "2026-11-15T05:00:00Z", midnight("2026-11-21"), "2026-11-14", "2026-11-21", "2/2");
    assert.equal(api.length, before, "Imported workspace questions must use only the supplied data.");
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("EN/VI continuous visibility passed for saved B2, legacy archive limits, pinned outage and imported B2." +
    (replay ? " The live B2 aggregate replay also passed." : " Live B2 success replay was not supplied."));
} finally {
  await browser.close();
}
