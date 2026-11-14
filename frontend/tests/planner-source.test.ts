import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveOptions, landingClock, liveExtras, plannerFormState, savedLandingHour } from "../lib/planner-source.ts";
import { searchArchiveB2 } from "../lib/archive-b2.ts";

function form(values: Record<string, string>) {
  const result = new FormData();
  for (const [name, value] of Object.entries(values)) result.set(name, value);
  return result;
}

test("links after editing dates use the two displayed dates and visibility priority", () => {
  const seed = new URLSearchParams({ from: "2026-11-14", to: "2026-11-21", priority: "sun" });
  const p = plannerFormState(seed, "sites", "live", form({ from: "2026-12-01", to: "2026-12-04", priority: "earth" }));
  assert.deepEqual(Object.fromEntries(p), { mode: "sites", from: "2026-12-01", to: "2026-12-04", priority: "earth" });
  assert.equal(seed.get("priority"), "sun");
});

test("same-hour landing, duration, unsupported constraints and ranking survive switching sources", () => {
  const site = "im2_athena", instant = "2026-11-15T23:00";
  const p = plannerFormState(new URLSearchParams(), "dates", "live", form({
    landingSite: site, missionHours: "1", earliest: instant, latest: instant, objective: "balanced",
    minBothPct: "0", maxEarthGap: "0", maxResults: "5", separationHours: "4", sunAtLanding: "on",
  }));
  assert.deepEqual(Object.fromEntries(p), {
    mode: "dates", site, earliest: instant, latest: instant, missionHours: "1", priority: "joint",
    from: "2026-11-15", to: "2026-11-16", maxEarthGap: "0", separationHours: "4", liveObjective: "balanced", sunAtLanding: "1",
  });
  assert.deepEqual(liveExtras(p), { maxEarthGap: "0", separationHours: "4" });
  assert.ok(hasLiveOptions(p));
  const savedFields = {
    savedLandingSite: site, savedFrom: "2026-11-15", savedTo: "2026-11-16", savedEarliest: instant,
    savedLatest: instant, savedDuration: "1", savedPriority: "joint",
  };
  assert.deepEqual(plannerFormState(p, "dates", "saved-b2", form(savedFields)), p);
  const changed = plannerFormState(p, "dates", "saved-b2", form({ ...savedFields, savedPriority: "earth", savedEarliest: "" }));
  assert.equal(changed.get("priority"), "earth");
  assert.equal(changed.has("earliest"), false);
  assert.equal(changed.has("liveObjective"), false);
  assert.deepEqual(liveExtras(changed), { maxEarthGap: "0", separationHours: "4" });
});

test("sub-hour bounds round inward solely for model evaluation, including when no grid hour fits", () => {
  const p = plannerFormState(new URLSearchParams(), "dates", "live", form({
    earliest: "2026-11-15T04:00:01", latest: "2026-11-15T05:59:59", missionHours: "24", landingSite: "im2_athena", objective: "earth",
  }));
  assert.equal(p.get("to"), "2026-11-17");
  assert.equal(landingClock(p, "earliest"), "2026-11-15T04:00:01");
  assert.equal(landingClock(p, "latest"), "2026-11-15T05:59:59");
  const query = { siteId: "im2_athena", from: p.get("from")!, to: p.get("to")!, missionHours: 24, priority: "earth" as const,
    earliest: savedLandingHour(p.get("earliest")!, "earliest"), latest: savedLandingHour(p.get("latest")!, "latest") };
  assert.equal(query.earliest, query.latest);
  assert.equal(query.earliest, "2026-11-15T05:00:00");
  assert.equal(searchArchiveB2(query)?.nEvaluated, 1);
  assert.equal(searchArchiveB2({ ...query, latest: savedLandingHour("2026-11-15T04:59:59", "latest") }), null);
  assert.equal(landingClock(new URLSearchParams({ earliest: "2026-02-30T19:00" }), "earliest"), undefined);
});
