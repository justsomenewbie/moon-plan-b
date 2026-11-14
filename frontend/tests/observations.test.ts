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
