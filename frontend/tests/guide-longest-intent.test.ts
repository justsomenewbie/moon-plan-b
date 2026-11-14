import assert from "node:assert/strict";
import test from "node:test";
import { hasPlanningQualifications, planningIntent } from "../lib/guide-planning.ts";

const range = "2026-11-28 to 2026-12-12";
test("recognizes explicit date-first requests for the longest uninterrupted joint window in English and Vietnamese", () => {
  const questions = [
    "Which site has the longest uninterrupted visibility of the Sun and Earth from " + range + "?",
    "Where can I see the Sun and Earth for the longest stretch without a break from " + range + "?",
    "What landing site has the longest joint window from " + range + "?",
    "Từ 2026-11-28 đến 2026-12-12, địa điểm nào nhìn thấy đồng thời Mặt Trời và Trái Đất liên tục lâu nhất?",
  ];
  for (const question of questions) {
    const intent = planningIntent(question);
    assert.deepEqual([intent?.mode, intent?.priority, intent?.longestJoint, intent?.from, intent?.to, intent?.missionHours],
      ["sites", "joint", true, "2026-11-28", "2026-12-12", null], question);
  }
  const first = planningIntent("Which site has the longest uninterrupted visibility of Sun and Earth?")!;
  assert.equal(first.from, null);
  assert.equal(first.longestJoint, true);
  assert.equal(planningIntent(range, first)?.longestJoint, true);
  assert.equal(planningIntent("For 24 hours from " + range, first)?.longestJoint, undefined);
});

test("unsupported uninterrupted objectives retain their qualification rather than becoming a total-hours answer", () => {
  for (const question of [
    "Which site has the longest continuous sunlight from " + range + "?",
    "Which site has the longest consecutive Earth visibility from " + range + "?",
    "Where can I get the longest uninterrupted view of the Sun or the Earth from " + range + "?",
    "Which site has at least 72 hours of continuous joint visibility from " + range + "?",
    "Which site has the longest continuous joint window in a 24-hour mission from " + range + "?",
    "Which site has the longest uninterrupted view of Sun and Earth without fuel from " + range + "?",
    "Từ 2026-11-28 đến 2026-12-12, địa điểm nào thấy Trái Đất liên tục lâu nhất?",
    "Từ 2026-11-28 đến 2026-12-12, địa điểm nào thấy Mặt Trời hoặc Trái Đất liên tục lâu nhất?",
  ]) {
    const intent = planningIntent(question);
    assert.equal(intent?.longestJoint, undefined, question);
    // Higher-level routing handles already unsupported safety questions such as fuel.
    if (intent) assert.ok(hasPlanningQualifications(intent.siteText), question);
  }
});

test("plain mission duration, aggregate hours and unrelated longest questions keep their own meaning", () => {
  const mission = planningIntent("Which site is best for a 24-hour mission from " + range + "?");
  assert.equal(mission?.missionHours, 24);
  assert.equal(mission?.longestJoint, undefined);
  for (const q of ["Which site gets the most hours of Sun and Earth from " + range + "?",
    "Which site can I see the Sun and Earth the longest from " + range + "?"]) {
    const plan = planningIntent(q)!;
    assert.equal(plan.longestJoint, undefined);
    assert.equal(hasPlanningQualifications(plan.siteText), false);
  }
  assert.equal(planningIntent("Which site has the longest uninterrupted weather record?"), null);
  assert.equal(planningIntent("Which site has the longest uninterrupted film?"), null);
});
