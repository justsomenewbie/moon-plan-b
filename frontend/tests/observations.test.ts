import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as dataset from "../lib/dataset.ts";
import type { Dataset, Scenario } from "../lib/dataset.ts";
import { translate } from "../lib/i18n.ts";
import type { Locale, Message, MessageValues } from "../lib/i18n.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const { createElement } = require("react") as typeof import("react");
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
// Node strips TypeScript but not JSX; compile this component with the installed compiler.
const output = ts.transpileModule(readFileSync(new URL("../app/observations.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = { exports: {} as typeof import("../app/observations") };
let locale: Locale = "en";
new Function("require", "exports", output)((id: string) => id === "../lib/dataset" ? dataset : id === "./language" ? { useLanguage: () => ({ locale, t: (message: Message, values?: MessageValues) => translate(locale, message, values) }) } : require(id), compiled.exports);
const fixture = () => JSON.parse(readFileSync(new URL("../public/data/demo.json", import.meta.url), "utf8")) as Dataset;
const windows = (a: Scenario, b?: Scenario) => renderToStaticMarkup(createElement(compiled.exports.Windows, { a, b }));

test("site finder reports every supplied assessment separately from unavailable sites", () => {
  const data = fixture();
  const render = (scenarios: Scenario[], h: number) => renderToStaticMarkup(createElement(compiled.exports.SiteAssessments, { data, scenarios, h }));
  const [ridge, , basin, , partial] = data.scenarios;
  data.sources = [{ id: "test-source", title: "Fixture record", url: "https://example.invalid/test", version: "test", retrievedAtUtc: ridge.startUtc, rawSha256: null }];
  ridge.sourceIds = ["test-source", "test-source"];
  const repeat = { ...ridge, id: "second-ridge-run" };
  const result = render([ridge, basin, repeat], 6);
  assert.equal(result.match(/>Meets the criterion</g)?.length, 2);
  assert.match(result, /Near the threshold/);
  for (const s of [ridge, basin, repeat]) assert.ok(result.includes(s.id));
  assert.ok(result.includes(data.datasetId) && result.includes(basin.criteria[0].reason));
  assert.ok(result.includes(ridge.startUtc) && result.includes(ridge.endUtc));
  assert.equal(result.match(/href="#source-test-source"/g)?.length, 2); // one link per ridge run
  const sources = renderToStaticMarkup(createElement(compiled.exports.Sources, { data, a: ridge }));
  assert.ok(sources.includes('id="source-test-source"') && sources.includes("Fixture record"));
  assert.doesNotMatch(result, /No published window/);
  assert.match(render([ridge, basin], 12), /Below the criterion/);
  locale = "vi";
  try {
    const gap = render([partial], 6);
    assert.match(gap, /Chưa đủ dữ liệu/);
    assert.match(gap, /Chưa có dữ liệu cho khoảng thời gian này/);
    assert.ok(gap.includes(partial.criteria[0].reason));
    assert.doesNotMatch(gap, /0 h/);
  } finally { locale = "en"; }
});

test("visibility text retains each supplied body, scenario and precise clipped boundary", () => {
  const [a, b] = fixture().scenarios;
  a.intervals!.sun[0].startUtc = "2026-11-14T06:00:15.125Z";
  a.intervals!.sun[0].endClipped = true;
  const html = windows(a, b);
  for (const scenario of [a, b]) for (const body of ["sun", "earth", "simultaneous"] as const) {
    for (const interval of scenario.intervals![body]) {
      assert.ok(html.includes(`${interval.startUtc} → ${interval.endUtc}`));
    }
  }
  for (const label of ["Primary", "Alternative", "Sun", "Earth", "Sun and Earth together"]) assert.ok(html.includes(`>${label}</h`));
  assert.ok(html.includes("Clipped at window end; interval end is unknown."));
});

test("visibility text distinguishes unavailable, empty and absent alternatives", () => {
  const data = fixture();
  const unavailable = windows(data.scenarios.find((s) => s.intervals === null)!);
  assert.ok(unavailable.includes("Intervals unavailable because coverage is incomplete."));
  assert.ok(!unavailable.includes("No supplied interval"));
  const a = data.scenarios[0];
  a.intervals = { sun: [], earth: [], simultaneous: [] };
  const empty = windows(a);
  assert.equal(empty.match(/No supplied interval in this window\./g)?.length, 3);
  assert.ok(!empty.includes("Alternative"));
});

test("timeline exposes producer-supplied golden windows without deriving replacements", () => {
  const [a, b] = fixture().scenarios;
  const html = renderToStaticMarkup(createElement(compiled.exports.Timeline, { a, b, mode: "dates", offset: 0 }));
  assert.equal(html.match(/Golden window supplied visibility intervals/g)?.length, 2);
  assert.match(html, /frontend does not calculate new scientific boundaries/);
  for (const scenario of [a, b]) for (const interval of scenario.intervals!.simultaneous) {
    assert.ok(html.includes(`x="${(Date.parse(interval.startUtc) - Date.parse(scenario.startUtc)) / (Date.parse(scenario.endUtc) - Date.parse(scenario.startUtc)) * 800}`));
  }
});

test("polar skyplot keeps shape labels, cardinal directions and exact numeric readout", () => {
  const scenario = fixture().scenarios[0];
  const html = renderToStaticMarkup(createElement(compiled.exports.SkyPosition, { scenario, offset: 9 * 3600000 }));
  assert.match(html, /class="skyplot"/);
  assert.match(html, /Polar skyplot of Sun and Earth/);
  for (const direction of ["N", "E", "S", "W"]) assert.ok(html.includes(`>${direction}</text>`));
  assert.ok(html.includes(`${scenario.samples[3].sun!.elevationDeg.toFixed(1)}°`));
  assert.match(html, /<circle[^>]+class="sun"|class="sun"[^>]*><circle/);
  assert.match(html, /<rect/);
});

test("sample scroll regions are keyboard focusable and named by unique table captions", () => {
  const [a, b] = fixture().scenarios;
  const html = renderToStaticMarkup(createElement(compiled.exports.SampleTable, { a, b }));
  for (const i of [0, 1]) {
    assert.ok(html.includes(`tabindex="0" role="region" aria-labelledby="sample-caption-${i}"`));
    assert.equal(html.match(new RegExp(`id="sample-caption-${i}"`, "g"))?.length, 1);
  }
});

test("Vietnamese observations retain exact UTC boundaries, values and original producer evidence", () => {
  locale = "vi";
  try {
    const data = fixture(), [a, b] = data.scenarios;
    const intervals = windows(a, b);
    assert.ok(intervals.includes("Xem khoảng thời gian trên chân trời"));
    assert.ok(intervals.includes("Mặt Trời và Trái Đất đồng thời"));
    for (const interval of a.intervals!.sun) assert.ok(intervals.includes(`${interval.startUtc} → ${interval.endUtc}`));
    const table = renderToStaticMarkup(createElement(compiled.exports.SampleTable, { a, b }));
    assert.ok(table.includes("Góc cao Mặt Trời"));
    assert.ok(table.includes(a.samples[0].utc));
    assert.ok(table.includes(`${a.samples[0].sun!.elevationDeg}°`));
    const comparison = renderToStaticMarkup(createElement(compiled.exports.Comparison, { a, b, h: data.criteriaHours[0] }));
    assert.ok(comparison.includes("Giải thích gốc của bên cung cấp"));
    assert.ok(comparison.includes(a.criteria[0].reason));
    const sources = renderToStaticMarkup(createElement(compiled.exports.Sources, { data, a, b }));
    assert.ok(sources.includes(data.attribution));
    assert.ok(sources.includes(data.model.definition));
    assert.ok(compiled.exports.formatUtc("2026-11-14T00:00:00Z", "vi").includes("00:00"));
    assert.ok(compiled.exports.formatUtc("2026-11-14T00:00:00Z", "vi").endsWith(" UTC"));
  } finally { locale = "en"; }
});
