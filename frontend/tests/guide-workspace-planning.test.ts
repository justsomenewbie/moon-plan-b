import assert from "node:assert/strict";
import test from "node:test";
import type { TerrainSummary } from "../lib/api/terrain-summary.ts";
import type { SiteComparison } from "../lib/api/compare-sites.ts";
import { type GuideContext } from "../lib/api/guide-chat.ts";
import { guideObservation, nextGuideUpdate, selectedModelSample } from "../lib/guide-observation.ts";
import { planningIntent } from "../lib/guide-planning.ts";
import { answerWorkspacePlanning } from "../lib/guide-workspace-planning.ts";

const origin = Date.parse("2026-11-14T00:00:00Z");
const stamp = (hours: number) => new Date(origin + hours * 3600000).toISOString().replace(".000Z", "Z");
const from = stamp(0), to = stamp(72), source = "fixture-retained-A";
const range = { start: from, end: to, requested_start: from, requested_end: to, n_samples: 72, step_s: 3600 };
const spans = (rows: number[][]) => rows.map(([a,b]) => ({ start: stamp(a), end: stamp(b), duration_h: b - a,
  clipped_start: false, clipped_end: false }));
const sites = ["Odysseus", "Athena"].map(name => ({ id: name.toLowerCase(), name, coverage: "complete", coverage_in_range: "complete",
  windows: { sun: spans([[12,38],[42,53]]), earth: spans([[0,72]]), both: spans([[12,38],[42,53]]) } }));
const terrain = { schema_version: "lunarnav-dataset-1", run: { run_id: source }, range, sites } as TerrainSummary;
const context: GuideContext = { kind: "terrain", rows: sites.map(site => ({ site: site.name, source, from, to, sunHours: 37, earthHours: 72, bothHours: 37 })) };

test("selecting one of two retained sites keeps the workspace and its exact dates", () => {
  const plan = planningIntent("When should I visit Odysseus or Athena for 3 hours from 2026-11-15 to 2026-11-16?")!;
  const offered = answerWorkspacePlanning(plan, "en", context, terrain);
  assert.ok("siteChoices" in offered && offered.siteChoices);
  const chosen = planningIntent("Athena", plan, offered.siteChoices)!;
  const answer = answerWorkspacePlanning(chosen, "en", context, terrain).answer;
  assert.match(answer, /Athena/);
  assert.match(answer, /2026-11-15T00:00:00Z → 2026-11-15T03:00:00Z/);
  assert.ok(answer.includes(source));
  assert.doesNotMatch(answer, /Odysseus/);
});
function query(question: string, evidence: TerrainSummary | SiteComparison = terrain, selected = context, locale: "en" | "vi" = "en") {
  const plan = planningIntent(question);
  assert.ok(plan);
  return answerWorkspacePlanning(plan, locale, selected, evidence);
}

test("a selected import answers the named site using only its own clipped native windows", () => {
  const answer = query("How many hours can Odysseus see both Sun and Earth from 2026-11-15 to 2026-11-16?");
  assert.equal(answer.action, "workspace");
  assert.match(answer.answer, /Odysseus/);
  assert.match(answer.answer, /20 \/ 24 \/ 20 h/);
  assert.match(answer.answer, /fixture-retained-A/);
  assert.doesNotMatch(answer.answer, /Athena|saved run/i);
});

test("the workspace ranks uninterrupted joint intervals within the retained sites and dates", () => {
  const question = "Which site has the longest uninterrupted Sun and Earth visibility from 2026-11-15 to 2026-11-16?";
  const plan = planningIntent(question)!;
  assert.equal(plan.longestJoint, true);
  const namedIntervals = (entries: number[][]) => ({ sun: spans(entries), earth: spans([[0,72]]), both: spans(entries) });
  const retained = { ...terrain, sites: [
    { ...terrain.sites[0], windows: namedIntervals([[20,34],[36,46]]) },
    { ...terrain.sites[1], windows: namedIntervals([[36,52]]) },
  ] };
  // Within [24,48), Odysseus has 20 hours split into two 10-hour spans. Athena has 12 continuous hours.
  const answer = answerWorkspacePlanning(plan, "en", context, retained);
  assert.equal(answer.action, "workspace");
  assert.match(answer.answer, /2\/2/);
  assert.match(answer.answer, /Athena/);
  assert.ok(answer.answer.includes(stamp(36)) && answer.answer.includes(stamp(48)));
  assert.doesNotMatch(answer.answer, /Odysseus|23 sites/);
  assert.ok(answer.answer.includes(source));

  const withoutAthena = { ...retained, sites: [retained.sites[0], { ...retained.sites[1], coverage_in_range: "partial" as const }] };
  const partial = answerWorkspacePlanning(plan, "vi", context, withoutAthena).answer;
  assert.match(partial, /1\/2/);
  assert.match(partial, /Dữ liệu chưa đầy đủ · Athena/);
  assert.ok(partial.includes(stamp(24)) && partial.includes(stamp(34)));

  const pairStates = [
    { start: stamp(0), end: stamp(12), state: false }, { start: stamp(12), end: stamp(60), state: true },
    { start: stamp(60), end: stamp(72), state: false },
  ];
  const pairWindows = { sun: pairStates, earth: pairStates, both: pairStates };
  const pair = { range, run_id: source, ranking: sites.map(s => ({site_id:s.id,name:s.name})),
    sites: { odysseus:{windows:pairWindows}, athena:{windows:pairWindows} }, coverageBySite:{odysseus:"complete",athena:"complete"} } as unknown as SiteComparison;
  const tied = answerWorkspacePlanning(plan, "en", context, pair).answer;
  assert.match(tied, /2\/2/);
  assert.ok(tied.includes("Athena") && tied.includes("Odysseus"));
  assert.ok(tied.includes(stamp(24)) && tied.includes(stamp(48)));
  const noIntervals = answerWorkspacePlanning(plan, "en", { ...context, kind:"scenario" }).answer;
  assert.match(noIntervals, /requires the site's joint intervals/);
  assert.doesNotMatch(noIntervals, /20 h|12 h|Athena|Odysseus/);
});

test("local date and site searches return the earliest tied start for each equally scoring site in the selected scope", () => {
  const answer = query("Which site is best for 3 hours from 2026-11-15 to 2026-11-16?").answer;
  assert.match(answer, /2\/2/);
  for (const name of ["Odysseus","Athena"]) assert.ok(answer.includes(name));
  assert.match(answer, /3 h/);
  assert.match(answer, /2026-11-15T00:00:00Z → 2026-11-15T03:00:00Z/);
  assert.match(answer, /16\/22/);
  const vi = query("Khi nào nên đi Athena 3 giờ từ 15 đến 16 tháng 11 năm 2026?", terrain, context, "vi").answer;
  assert.match(vi, /Khoảng tốt nhất sớm nhất/);
  assert.match(vi, /Athena/);
  assert.doesNotMatch(vi, /Odysseus/);
});

test("the displayed pair counts only visible spans, excludes a partial site, and treats covered zero hours as zero", () => {
  const g = (a:number,b:number,state:boolean) => ({start:stamp(a),end:stamp(b),state});
  const partition = [g(0,30,false),g(30,35,true),g(35,72,false)];
  const windows = { sun: partition, earth: partition, both: partition };
  const pair = { range, run_id: source, ranking: sites.map(s => ({site_id:s.id,name:s.name})),
    sites: { odysseus:{windows}, athena:{windows} }, coverageBySite:{odysseus:"complete",athena:"partial"} } as unknown as SiteComparison;
  const sample = selectedModelSample(context, pair);
  assert.deepEqual(guideObservation(Date.parse(stamp(30)), sample)?.readings, [{ name: "Odysseus", visibility: "both" }]);
  assert.deepEqual(guideObservation(Date.parse(stamp(35)), sample)?.readings, [{ name: "Odysseus", visibility: "neither" }]);
  assert.equal(nextGuideUpdate(Date.parse(stamp(30)) + 1, sample), Date.parse(stamp(31)));
  assert.equal(guideObservation(Date.parse(to), sample), null);
  const onlySource = query("Which site is best from 2026-11-15 to 2026-11-16?", pair).answer;
  assert.match(onlySource, /1\/2/);
  assert.match(onlySource, /Incomplete coverage · Athena/);
  assert.match(onlySource, /Odysseus.*5 h/);
  const zero = query("Which site is best from 2026-11-14 to 2026-11-15?", pair).answer;
  assert.match(zero, /No evaluated site has any hours/);
  const missing = query("When can I visit Haworth for 3 hours from 2026-11-15 to 2026-11-16?", pair).answer;
  assert.match(missing, /Which retained site/);
  assert.doesNotMatch(missing, /Equally scoring starts/);
});

test("scope, date, mission and evidence limits never fall back to a different provider", () => {
  assert.match(query("Which site is best from 2026-11-13 to 2026-11-16?").answer, /outside this workspace/);
  assert.match(query("Which site is best for 25 hours from 2026-11-15 to 2026-11-16?").answer, /one whole mission duration/);
  assert.match(query("Which site is best for at least 2 hours from 2026-11-15 to 2026-11-16?").answer, /extra condition/);
  const observation = "How many hours can Odysseus see the Sun from 2026-11-15 to 2026-11-16?";
  assert.match(query(observation, terrain, { ...context, kind:"synthetic" }).answer, /fictional/);
  assert.match(query(observation, terrain, { ...context, kind:"scenario" }).answer, /exact site windows/);
  assert.match(query(observation, terrain, { ...context, rows:context.rows.map(r => ({...r,source:"some-other-run"})) }).answer, /summary totals only/);
});

test("recorded scenario routes answer exact summaries, preserve ties and reject hours within an unsupported subwindow", () => {
  const scenario: GuideContext = { ...context, kind: "scenario" };
  const date = "from 2026-11-14 to 2026-11-17?";
  const direct = query("How much sunlight is at Odysseus " + date, terrain, scenario).answer;
  assert.match(direct, /Odysseus.*37 \/ 72 \/ 37 h.*fixture-retained-A/);
  assert.doesNotMatch(direct, /Athena/);
  assert.match(query("Which site is best " + date, terrain, scenario).answer, /Odysseus[\s\S]*Athena/);
  assert.match(query("Which site is best for 2 hours " + date, terrain, scenario).answer, /exact site windows/);
  const incomplete = { ...scenario, rows: scenario.rows.map(row => ({...row, sunHours: null})) };
  assert.match(query("Which site is best " + date, terrain, incomplete).answer, /no complete totals/);
});
