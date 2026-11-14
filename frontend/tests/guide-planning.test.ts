import assert from "node:assert/strict";
import test from "node:test";
import { planningIntent } from "../lib/guide-planning.ts";
import { answerPlanning, matchSites } from "../lib/api/guide-planning.ts";
import { parseGuideRequest, answerGuide } from "../lib/guide-chat.ts";
import { savedGuideContext } from "../lib/api/guide-chat.ts";
import type { PlannerRun, PlannerRanking } from "../lib/api/planner.ts";
import type { AltDatesResponse } from "../lib/api/alt-dates.ts";

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
const api = { online: true, run: async () => run, ranking: unintended, observation: unintended, dates: unintended };

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
