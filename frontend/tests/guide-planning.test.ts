import assert from "node:assert/strict";
import test from "node:test";
import { planningIntent } from "../lib/guide-planning.ts";
import { answerPlanning, matchSites } from "../lib/api/guide-planning.ts";
import { parseGuideRequest, answerGuide } from "../lib/guide-chat.ts";
import { savedGuideContext } from "../lib/api/guide-chat.ts";
import type { PlannerRun, PlannerRanking } from "../lib/api/planner.ts";
import type { AltDatesResponse } from "../lib/api/alt-dates.ts";
import type { TerrainSummary } from "../lib/api/terrain-summary.ts";

const first = "2026-11-21T00:00:00Z", end = "2026-11-28T00:00:00Z";
const examples = {
  en: "If I go from November 21 to 28, 2026, where do I get the most time with both Sun and Earth in view?",
  vi: "Tôi muốn đi từ 21 đến 28 tháng 11 năm 2026, địa điểm nào có nhiều giờ nhìn thấy cả Mặt Trời và Trái Đất nhất?",
};
const signal = new AbortController().signal;
const site = (id: string, name: string) => ({ id, name, demSource: "test", lat_deg: null, lon_deg: null, horizonMethod: "test" });
const run: PlannerRun = { runId: "fixture-run", start: "2026-01-01T00:00:00Z", end: "2028-01-01T00:00:00Z", stepSeconds: 3600,
  sites: [site("im2_athena", "IM-2 Athena"), site("apollo11", "Apollo 11 LM Eagle (Tranquility Base)"), site("apollo15", "Apollo 15 LM Falcon (Hadley-Apennine)")] };
const unintended = async () => { throw Error("Unexpected lookup"); };
const api = { online: true, run: async () => run, windows: unintended, ranking: unintended, missionRanking: unintended, observation: unintended, dates: unintended };

test("the guide ranks uninterrupted visibility from intervals and keeps the winning objective in the planner", async () => {
  const q = planningIntent("Which site has the longest uninterrupted visibility of the Sun and Earth from 2026-11-28 to 2026-12-12?")!;
  const saved = await answerPlanning(q, "en", signal, api, "saved-b2");
  assert.match(saved.answer, /23\/23[\s\S]*Odysseus[^\n]*92 h · 2026-11-28T00:00:00Z → 2026-12-01T20:00:00Z/);
  assert.match(saved.answer, /Visibility ends ±1 h/);
  assert.doesNotMatch(saved.answer, /Malapert|Visibility starts/);
  assert.equal(new URL(saved.href, "https://example.org").searchParams.get("order"), "longest");
  const old = await answerPlanning(q, "vi", signal, api, "saved");
  assert.match(old.answer, /Bản lưu này không có các khoảng/);
  assert.doesNotMatch(old.answer, /92 h|B2_|±/);
  const oldWeek = planningIntent("Địa điểm nào cùng thấy Mặt Trời và Trái Đất liên tục lâu nhất từ 2026-11-14 đến 2026-11-21?")!;
  assert.match((await answerPlanning(oldWeek, "vi", signal, api, "saved")).answer, /Athena[^\n]*Bắt đầu cùng thấy ±1 h/);

  const s = "2026-11-28T00:00:00Z", mid = "2026-11-28T01:00:00Z", e = "2026-11-28T03:00:00Z";
  const complete = { coverage: "complete", coverage_in_range: "complete" };
  const hits: string[] = [];
  const result = await answerPlanning(q, "en", signal, { ...api, windows: async (pinned, bounds) => {
    hits.push(pinned.runId);
    assert.deepEqual(bounds, { from: s, to: "2026-12-12T00:00:00Z", priority: "joint" });
    return { sites: [
      { ...complete, id: "im2_athena", name: "Athena", windows: { both: [{ start: s, end: mid }, { start: mid, end: e }] } },
      { ...complete, id: "apollo11", name: "Apollo 11", windows: { both: [] } },
      { ...complete, coverage: "partial", id: "apollo15", name: "Apollo 15", windows: { both: [{ start: s, end: bounds.to }] } },
    ] } as unknown as PlannerRanking["evidence"];
  } }, { ...run, stepSeconds: 1800 });
  assert.deepEqual(hits, [run.runId]);
  assert.match(result.answer, /2\/3[\s\S]*Athena · 3 h[^\n]*Visibility ends ±30 min/);
  assert.doesNotMatch(result.answer, /Apollo 15|92 h/);
  const failed = await answerPlanning(q, "en", signal, api, run);
  assert.match(failed.answer, /could not verify[\s\S]*fixture-run/);
  assert.doesNotMatch(failed.answer, /92 h|B2_/);
});

test("English and Vietnamese site clarifications retain travel bounds, duration, priority and the saved source", async () => {
  for (const [locale, question] of [
    ["en", "When should I visit Odysseus or Athena for 6 hours of sunlight from 2026-11-14 to 2026-11-21?"],
    ["vi", "Khi nào nên đi Odysseus hoặc Athena 6 giờ có ánh sáng Mặt Trời từ 2026-11-14 đến 2026-11-21?"],
  ] as const) {
    let plan = planningIntent(question)!;
    let answer = await answerPlanning(plan, locale, signal, api, "saved-b2");
    const offered = ["im1_odysseus", "im2_athena"];
    assert.deepEqual(answer.siteChoices?.map(site => site.id).sort(), offered);
    for (const uncertain of ["Odysseus or Athena", "Plato"]) {
      plan = planningIntent(uncertain, plan, answer.siteChoices)!;
      answer = await answerPlanning(plan, locale, signal, api, answer.choiceSource);
      assert.deepEqual(answer.siteChoices?.map(site => site.id).sort(), offered);
    }
    const next = planningIntent("Athena", plan, answer.siteChoices)!;
    assert.deepEqual([next.mode, next.priority, next.from, next.to, next.missionHours], ["dates", "sun", "2026-11-14", "2026-11-21", 6]);
    const result = await answerPlanning(next, locale, signal, api, answer.choiceSource);
    assert.match(result.answer, /IM-2 Athena/);
    assert.doesNotMatch(result.answer, /Odysseus/);
    const params = new URL(result.href, "https://example.org").searchParams;
    assert.deepEqual([params.get("site"), params.get("source"), params.get("missionHours"), params.get("priority")], ["im2_athena", "saved-b2", "6", "sun"]);
    assert.equal(result.siteChoices, undefined);
    const unrelated = planningIntent("Where should I go from 2027-03-01 to 2027-03-04?", plan, answer.siteChoices)!;
    assert.equal(unrelated.continuesSiteChoice, undefined);
    assert.equal(unrelated.missionHours, null);
  }
});

test("live disambiguation uses the offered release after the default changes", async () => {
  const plan = planningIntent("When can I visit Apollo for 4 hours from 2026-11-14 to 2026-11-21?")!;
  const offered = await answerPlanning(plan, "en", signal, api);
  assert.deepEqual(offered.siteChoices?.map(site => site.id), ["apollo11", "apollo15"]);
  assert.equal(offered.choiceSource, run);
  const next = planningIntent("Apollo 15", plan, offered.siteChoices)!;
  assert.equal(next.continuesSiteChoice, true);
  const result = await answerPlanning(next, "en", signal, { ...api, run: unintended, dates: async query => {
    assert.equal(query.site_id, "apollo15");
    assert.equal(query.run_id, run.runId);
    return { candidates: [] } as unknown as AltDatesResponse;
  } }, offered.choiceSource);
  assert.match(result.answer, /No qualifying model window/);
  assert.equal(new URL(result.href, "https://example.org").searchParams.get("run_id"), run.runId);
});

test("an explicit EN or VI travel window never uses last week's displayed rows", async () => {
  for (const locale of ["en", "vi"] as const) {
    const question = examples[locale], intent = planningIntent(question)!;
    assert.deepEqual([intent.mode, intent.from, intent.to, intent.priority], ["sites", "2026-11-21", "2026-11-28", "joint"]);
    const display = parseGuideRequest({ locale, question, context: savedGuideContext("2026-11-14T00:00:00Z") });
    assert.doesNotMatch(answerGuide(display, { topic: "mostHours", measure: "bothHours", rows: [] }).answer, /139 h|33 h/);
    const generated = await answerPlanning(intent, locale, signal, { ...api, ranking: async (r, q) => {
      assert.equal(r, run); assert.deepEqual(q, { from: first, to: end, priority: "joint" });
      return { recommendedIds: ["apollo11"], evidence: { sites: [{ id: "apollo11", name: "Apollo 11", metrics: { both_hours: 123 } }] } } as PlannerRanking;
    } });
    assert.match(generated.answer, /Apollo 11 · 123 h/); assert.match(generated.answer, /fixture-run/);
    assert.match(generated.href, /^\/plan\?mode=sites/);
    const offline = await answerPlanning(intent, locale, signal, { ...api, online: false }, "saved");
    assert.match(offline.answer, /Odysseus[^\n]+168 h/);
    assert.match(offline.answer, /Athena[^\n]+168 h/);
    assert.doesNotMatch(offline.answer, /139 h|33 h/);
    assert.match(offline.answer, /Saved comparison only|Chỉ xét kết quả so sánh đã lưu/);
  }
});

test("missing bounds and mission duration can be supplied in later turns without querying early", async () => {
  const question = "When can I visit Athena?", initial = planningIntent(question)!;
  const firstReply = await answerPlanning(initial, "en", signal, api);
  assert.match(firstReply.answer, /start and end dates/);
  const second = planningIntent("2026-11-21 to 2026-11-28", initial)!;
  assert.match((await answerPlanning(second, "en", signal, api)).answer, /How many hours/);
  const third = planningIntent("24 hours", second)!;
  const reply = await answerPlanning(third, "en", signal, { ...api, dates: async (request, step, _, grid) => {
    assert.deepEqual([request.site_id, request.earliest, request.latest, request.mission_h, step, grid],
      ["im2_athena", first, "2026-11-27T00:00:00Z", 24, 3600, run.start]);
    return { candidates: [{ landing_utc: first, mission_end_utc: "2026-11-22T00:00:00Z", sun_pct: 50, earth_pct: 25, both_pct: 25 }] } as AltDatesResponse;
  } });
  assert.equal(new URL(reply.href, "https://example.org").searchParams.get("run_id"), run.runId);
  assert.match(reply.answer, /50% \/ 25% \/ 25%/); assert.match(reply.href, /site=im2_athena/); assert.match(reply.href, /missionHours=24/);
  assert.equal(planningIntent("từ 21 đến 28 tháng 11, địa điểm nào oke nhất?")?.dateProblem, true);
  assert.equal(planningIntent("Where should I go from 2026-02-30 to 2026-03-02?")?.dateProblem, true);
  assert.equal(planningIntent("Which site has fewer hours?"), null);
  assert.equal(planningIntent("I want to go from 2026-11-21 to 2026-11-28.")?.mode, "sites");
  const constrained = planningIntent("Which site has at least 72 hours of continuous visibility from 2026-11-21 to 2026-11-28?")!;
  assert.match((await answerPlanning(constrained, "en", signal, api)).answer, /additional conditions/);
  assert.equal(planningIntent("Where is the safest landing site on 2026-11-24?"), null);
});

test("catalog names resolve exactly, missing coverage or dates do not produce stand-in hours", async () => {
  assert.deepEqual(matchSites("Apollo 11", run.sites).map(s => s.id), ["apollo11"]);
  assert.deepEqual(matchSites("Apollo", run.sites).map(s => s.id), ["apollo11", "apollo15"]);
  assert.deepEqual(matchSites("Mons Mouton Plateau", [site("a3_mons_mouton", "Artemis III region: Mons Mouton"), site("a3_mons_mouton_plateau", "Artemis III region: Mons Mouton Plateau")]).map(s => s.id), ["a3_mons_mouton_plateau"]);
  const q = planningIntent("How long is Earth visible at Apollo 11 on December 5, 2026?")!;
  const result = await answerPlanning(q, "en", signal, { ...api, online: false }, "saved");
  assert.match(result.answer, /could not verify/); assert.doesNotMatch(result.answer, /\d+ h\b/);
  const ambiguous = await answerPlanning(planningIntent("When can I visit Apollo for 24 hours from 2026-11-21 to 2026-11-28?")!, "en", signal, api);
  assert.match(ambiguous.answer, /Which of these sites/);
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(answerPlanning(q, "en", cancel.signal, { ...api, run: unintended }), { name: "AbortError" });
});

test("the astronaut can answer a saved complete catalog ranking or site-first search during an outage", async () => {
  const offline = { ...api, online: false };
  const catalog = await answerPlanning(planningIntent("Where should I visit from December 1 to 4, 2026?")!, "en", signal, offline, "saved");
  assert.match(catalog.answer, /Saved catalog · 23 sites/); assert.match(catalog.answer, /Odysseus[^\n]+20 h/);
  const mission = await answerPlanning(planningIntent("Khi nào nên đi Odysseus 24 giờ từ 14 đến 21 tháng 11 năm 2026?")!, "vi", signal, offline, "saved");
  assert.match(mission.answer, /2026-11-19T15:00:00Z → 2026-11-20T15:00:00Z/);
  assert.match(mission.answer, /10 mốc đồng hạng trong 145 mốc/);
});

test("no recommendation for a saved landing window with zero joint visibility", async () => {
  const plan = planningIntent("When should I land at Odysseus for 3 hours from 2026-11-15 to 2026-11-16?")!;
  const response = await answerPlanning(plan, "en", signal, {...api, online:false}, "saved");
  assert.match(response.answer, /No evaluated option/);
  assert.doesNotMatch(response.answer, /highest-visibility mission window/);
});

test("pinned B and B2 observation questions preserve the run and exact dated mission in EN and VI", async () => {
  const plans = {
    en: "How many hours can Odysseus see both the Sun and Earth from 2026-11-14 to 2026-11-21?",
    vi: "Odysseus thấy cả Mặt Trời và Trái Đất bao nhiêu giờ từ 14 đến 21 tháng 11 năm 2026?",
  };
  let liveCalls = 0;
  for (const locale of ["en", "vi"] as const) {
    const q = planningIntent(plans[locale])!;
    for (const source of ["saved", "saved-b2"] as const) {
      const reply = await answerPlanning(q, locale, signal, { ...api, run: async () => { liveCalls++; return run; } }, source);
      assert.match(reply.answer, source === "saved" ? / \/ 33 h/ : / \/ 47 h/);
      assert.match(reply.answer, source === "saved" ? /B_spice_pgda/ : /B2_spice_pgda/);
      const link = new URL(reply.href, "https://example.org");
      assert.equal(link.pathname, "/plan");
      for (const [key, value] of Object.entries({ source, mode: "dates", site: "im1_odysseus", from: "2026-11-14", to: "2026-11-21", missionHours: "168" }))
        assert.equal(link.searchParams.get(key), value);
    }
  }
  assert.equal(liveCalls, 0);
});

test("offline or unavailable live catalog uses all B2 sites for the actual 2029 dates", async () => {
  const q = planningIntent("Which site is best from February 12 to 19, 2029?")!;
  for (const online of [true, false]) {
    const reply = await answerPlanning(q, "en", signal, { ...api, online, run: unintended });
    assert.match(reply.answer, /Saved catalog · 23 sites/);
    assert.match(reply.answer, /connecting ridge, point C1 · 168 h/);
    assert.match(reply.answer, /B2_spice_pgda/);
    assert.match(reply.href, /source=saved-b2/);
    assert.match(reply.href, /from=2029-02-12&to=2029-02-19/);
  }
});

test("observation actions open the section provided for the pinned run and exact UTC span", async () => {
  const live = { ...run, end: "2031-01-01T00:00:00Z" };
  for (const [to, anchor] of [["2027-01-02", "#terrain-observations"], ["2027-01-03", "#workspace"], ["2031-01-01", "#workspace"]]) {
    const plan = planningIntent("How many hours of Sun and Earth visibility does Athena have from 2026-01-01 to " + to + "?")!;
    const reply = await answerPlanning(plan, "en", signal, { ...api, run: async () => live, observation: async (request, id, runId) => {
      assert.deepEqual([id, runId, request.to], ["im2_athena", live.runId, to + "T00:00:00Z"]);
      return { range: { start: request.from, end: request.to }, sites: [{ id, coverage: "partial", coverage_in_range: "partial" }] } as TerrainSummary;
    } });
    const url = new URL(reply.href, "https://example.org");
    assert.equal(url.pathname, "/compare");
    assert.equal(url.hash, anchor);
    assert.equal(url.searchParams.get("view_site"), "im2_athena");
    assert.equal(url.searchParams.get("run_id"), live.runId);
  }
});

test("a failed A2 lookup after discovery retains the same result source and recovery link as an explicit A2 pin", async () => {
  const a2 = { ...run, runId: "A2_horizons_trek_raymarch_2026_2030_fix676af9d" };
  const plan = planningIntent("How many hours of sun and earth visibility does Athena have from 2026-11-14 to 2026-11-21?")!;
  for (const locale of ["en", "vi"] as const) {
    let discoveries = 0, lookups = 0;
    const outage = { ...api, run: async () => { discoveries++; return a2; }, observation: async () => { lookups++; throw Error("Unavailable"); } };
    const discovered = await answerPlanning(plan, locale, signal, outage);
    const pinned = await answerPlanning(plan, locale, signal, outage, a2);
    assert.equal(discoveries, 1); assert.equal(lookups, 2);
    assert.deepEqual(discovered, pinned);
    assert.ok(discovered.answer.includes(a2.runId));
    assert.doesNotMatch(discovered.answer, /B2_|139 h/);
    const params = new URL(discovered.href, "https://example.org").searchParams;
    assert.deepEqual([params.get("run_id"), params.get("site"), params.get("from"), params.get("to")],
      [a2.runId, "im2_athena", "2026-11-14", "2026-11-21"]);
  }
});

test("B2 site search counts all starts and never recommends a zero-score interval", async () => {
  const joint = planningIntent("When should I land at Apollo 11 for 5 hours from 2029-02-12 to 2029-02-19?")!;
  const zero = await answerPlanning(joint, "en", signal, {...api, online: false});
  assert.match(zero.answer, /No evaluated option/);
  assert.doesNotMatch(zero.answer, /highest-visibility mission window/);
  const earth = await answerPlanning({...joint, priority:"earth"}, "en", signal, api, "saved-b2");
  assert.match(earth.answer, /164 tied starts out of 164/);
  assert.match(earth.href, /source=saved-b2/);
  assert.match(earth.href, /site=apollo11&missionHours=5/);
});


test("retains the planner's live model when answering a ranking question or offering retry", async () => {
  const q = planningIntent("Which site is best from 2026-11-15 to 2026-11-16?")!;
  const services = { ...api, run: unintended, ranking: async (model: PlannerRun) => {
    assert.equal(model, run);
    return { recommendedIds: [], evidence: { sites: [] } } as unknown as PlannerRanking;
  } };
  const answer = await answerPlanning(q, "en", signal, services, run);
  assert.match(answer.answer, /No catalog site has complete coverage/);
  const failed = await answerPlanning(q, "vi", signal, { ...services, ranking: unintended }, run);
  assert.match(failed.answer, /chưa xác minh/);
  for (const item of [answer, failed]) {
    const url = new URL(item.href, "https://example.org");
    assert.equal(url.searchParams.get("run_id"), run.runId);
    assert.equal(url.searchParams.has("source"), false);
  }
});

test("the astronaut ranks fixed visits within the week, retains duration in its link and distinguishes ties", async () => {
  const plans = {
    en: "Where should I go for a 24-hour mission from November 14 to 21, 2026?",
    vi: "Tôi muốn đi 24 giờ từ 14 đến 21 tháng 11 năm 2026, địa điểm nào tốt nhất?",
  };
  for (const locale of ["en", "vi"] as const) {
    const request = planningIntent(plans[locale])!;
    const result = await answerPlanning(request, locale, signal, api, "saved-b2");
    assert.match(result.answer, /24\/24 h/);
    assert.match(result.answer, /23\/23/);
    assert.match(result.answer, /Vikram[^\n]*2026-11-14T06:00:00Z → 2026-11-15T06:00:00Z/);
    assert.match(result.answer, /Athena[^\n]*2026-11-15T05:00:00Z/);
    assert.match(result.answer, /Odysseus[^\n]*2026-11-19T01:00:00Z/);
    assert.doesNotMatch(result.answer, /162 h/);
    assert.equal(result.answer.split(" → ").length - 2, 15);
    const url = new URL(result.href, "https://example.org");
    assert.equal(url.searchParams.get("mode"), "sites");
    assert.equal(url.searchParams.get("source"), "saved-b2");
    assert.equal(url.searchParams.get("missionHours"), "24");
  }
  const q = planningIntent(plans.en)!;
  const old = await answerPlanning(q, "en", signal, api, "saved");
  assert.match(old.answer, /Odysseus and Athena/);
  assert.doesNotMatch(old.answer, /Vikram/);
  for (const phrase of ["six-hour", "6-hour", "two-day", "1,5 ngày", "sáu tiếng", "một tuần", "6–12 hours", "1 day and 4 hours"]) {
    const parsed = planningIntent("Where should I go for a " + phrase + " mission from 2026-11-14 to 2026-11-21?")!;
    assert.equal(parsed.missionHours, ({ "six-hour":6, "6-hour":6, "two-day":48, "1,5 ngày":36, "sáu tiếng":6, "một tuần":168, "6–12 hours":0, "1 day and 4 hours":0 } as Record<string, number>)[phrase]);
  }
  for (const [locale, phrase] of [["en", "one or two days"], ["vi", "một hoặc hai ngày"], ["en", "between one and two days"], ["vi", "một đến hai ngày"]] as const) {
    const question = plans[locale].replace(locale === "en" ? "a 24-hour mission" : "24 giờ", phrase);
    const intent = planningIntent(question)!;
    assert.equal(intent.missionHours, 0, phrase);
    const result = await answerPlanning(intent, locale, signal, api, "saved-b2");
    assert.match(result.answer, locale === "en" ? /How many hours should the mission last/ : /Bạn muốn nhiệm vụ kéo dài bao nhiêu giờ/);
    assert.equal(new URL(result.href, "https://example.org").searchParams.has("missionHours"), false);
  }
  const invalid = await answerPlanning({ ...q, missionHours: 169 }, "vi", signal, api, "saved-b2");
  assert.match(invalid.answer, /số giờ nguyên/);
});

test("a saved run explains its UTC coverage and an explicit UTC clock never becomes an all-day ranking", async () => {
  const q = planningIntent("Where should I land for 24 hours from 2032-01-01 to 2032-01-03?")!;
  for (const source of ["saved", "saved-b2"] as const) {
    const answer = await answerPlanning(q, "en", signal, api, source);
    assert.match(answer.answer, /outside the model run/);
    assert.match(answer.answer, /2031-01-01T00:00:00Z/);
    assert.doesNotMatch(answer.answer, /retry/i);
  }
  const clock = planningIntent("Where should I land from 2026-11-14 08:00 to 2026-11-15 14:00?")!;
  const answer = await answerPlanning(clock, "vi", signal, api, "saved-b2");
  assert.match(answer.answer, /giờ bắt đầu UTC/);
  assert.doesNotMatch(answer.answer, /24 h/);
});
